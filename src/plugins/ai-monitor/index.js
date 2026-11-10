import logger from '../../utils/logger.ts';
import {
    configure as configureMonitorDb,
    insertRecord,
    shutdown as shutdownMonitorDb
} from './monitor-db.js';

/**
 * AI 接口监控插件
 * 功能：
 * 1. 捕获 AI 接口的请求参数（转换前和转换后）
 * 2. 捕获 AI 接口的响应结果（转换前和转换后，流式响应聚合输出）
 */
/**
 * @type {import('../../../types/plugin.js').Plugin & {
 *   streamCache: Map<string, { nativeChunks: unknown[], convertedChunks: unknown[], fromProvider: string, toProvider: string }>,
 *   requestStash: Map<string, any>,
 *   responseStash: Map<string, any>,
 *   stashRequest: (requestId: string, data: any) => void,
 *   persist: (requestId: string, responseData?: any) => void
 * }}
 */
const aiMonitorPlugin = {
    name: 'ai-monitor',
    version: '1.0.0',
    description: 'AI 接口监控插件 - 捕获请求和响应参数（全链路协议转换监控，流式聚合输出，用于调试和分析）',
    type: 'middleware',
    _priority: 100,

    // 用于存储流式响应的中间状态
    streamCache: new Map(),

    // 请求侧暂存：onContentGenerated 先记下请求报文，响应侧就绪后再整条落库。
    // 单独存是因为钩子触发顺序是 请求 → 响应，而记录需要两者合并成一行。
    requestStash: new Map(),

    /**
     * 暂存请求侧数据，等响应到达后合并落库。
     * 5 分钟未被响应补齐则丢弃（说明该请求异常中断）。
     */
    /** 响应侧先到时暂存于此，等请求侧钩子补齐后合并写入 */
    responseStash: new Map(),

    stashRequest(requestId, data) {
        // 若响应侧钩子已经先触发（顺序见 request-pipeline：onUnaryResponse 在
        // handleUnaryRequest 内部执行，早于 onContentGenerated 返回），
        // 这里直接合并落库，而不是留下一条缺请求报文的记录。
        const earlyResponse = this.responseStash.get(requestId);
        if (earlyResponse) {
            this.responseStash.delete(requestId);
            const entry = { ...data, createdAt: new Date().toISOString() };
            this.requestStash.set(requestId, entry);
            this.persist(requestId, earlyResponse);
            return;
        }
        this.requestStash.set(requestId, { ...data, createdAt: new Date().toISOString() });
        const timer = setTimeout(() => {
            if (this.requestStash.has(requestId)) {
                // 没有响应：仍然记录一行，标记 error，便于排查「请求发出但无响应」
                const stashed = this.requestStash.get(requestId);
                this.requestStash.delete(requestId);
                try {
                    insertRecord({
                        requestId,
                        createdAt: stashed.createdAt,
                        model: stashed.model,
                        fromProvider: stashed.fromProvider,
                        toProvider: stashed.toProvider,
                        isStream: stashed.isStream,
                        originalRequest: stashed.originalRequest,
                        processedRequest: stashed.processedRequest,
                        error: 'no response captured'
                    });
                } catch (error) {
                    logger.warn(`[AI Monitor] Failed to persist orphan request ${requestId}: ${error?.message || error}`);
                }
            }
        }, 5 * 60 * 1000);
        if (typeof timer.unref === 'function') timer.unref();
    },

    /**
     * 把请求侧与响应侧合并成一条记录写入 SQLite。
     * 写库失败只告警，绝不影响主请求链路。
     */
    persist(requestId, responseData = {}) {
        if (!requestId) return;
        const stashed = this.requestStash.get(requestId);
        // 请求侧还没到：先缓存响应，等 stashRequest 触发合并
        if (!stashed) {
            this.responseStash.set(requestId, responseData);
            // 兜底：10 分钟后仍无请求侧，就把响应单独落库，避免数据丢失
            const timer = setTimeout(() => {
                const orphan = this.responseStash.get(requestId);
                if (!orphan) return;
                this.responseStash.delete(requestId);
                try {
                    insertRecord({
                        requestId,
                        model: undefined,
                        fromProvider: orphan.fromProvider,
                        toProvider: orphan.toProvider,
                        isStream: orphan.isStream,
                        nativeResponse: orphan.nativeResponse,
                        clientResponse: orphan.clientResponse,
                        error: 'request side missing'
                    });
                } catch (error) {
                    logger.warn(`[AI Monitor] Failed to persist orphan response ${requestId}: ${error?.message || error}`);
                }
            }, 10 * 60 * 1000);
            if (typeof timer.unref === 'function') timer.unref();
            return;
        }
        this.requestStash.delete(requestId);
        try {
            insertRecord({
                requestId,
                createdAt: stashed.createdAt || new Date().toISOString(),
                model: stashed.model,
                fromProvider: responseData.fromProvider || stashed.fromProvider,
                toProvider: responseData.toProvider || stashed.toProvider,
                isStream: responseData.isStream ?? stashed.isStream,
                originalRequest: stashed.originalRequest,
                processedRequest: stashed.processedRequest,
                nativeResponse: responseData.nativeResponse,
                clientResponse: responseData.clientResponse
            });
        } catch (error) {
            logger.warn(`[AI Monitor] Failed to persist record ${requestId}: ${error?.message || error}`);
        }
    },

    async init(config) {
        // 容量控制参数可由插件 config 覆盖（默认保留 7 天 / 最多 2 万行 / 单条 256KB）
        configureMonitorDb(config || {});
        logger.info('[AI Monitor Plugin] Initialized (SQLite persistence enabled)');
    },

    /** 插件卸载时释放数据库与定时器 */
    async destroy() {
        shutdownMonitorDb();
    },

    /**
     * 中间件：初始化请求上下文
     */
    async middleware(req, res, requestUrl, config) {
        const aiPaths = [
            '/v1/chat/completions', 
            '/v1/responses', 
            '/v1/messages', 
            '/v1/images/generations',
            '/v1/images/edits'
        ];
        const isAiPath = aiPaths.some(path => requestUrl.pathname.includes(path));

        if (isAiPath && req.method === 'POST' && !config._monitorRequestId) {
            // 在监控插件中生成请求标识，并存入 config 以供全链路追踪
            const requestId = Date.now() + Math.random().toString(36).substring(2, 10);
            config._monitorRequestId = requestId;
        }
        
        return { handled: false };
    },

    hooks: {
        /**
         * 请求转换后的钩子
         */
        async onContentGenerated(config) {
            const { originalRequestBody, processedRequestBody, fromProvider, toProvider, model, _monitorRequestId, isStream } = config;
            if (!originalRequestBody) return;
            const traceRequestId = _monitorRequestId;

            // 请求侧落库（响应侧在 onUnaryResponse / onStreamChunk 聚合后补齐）
            const dbRequestId = traceRequestId;
            if (dbRequestId) {
                aiMonitorPlugin.stashRequest(dbRequestId, {
                    model,
                    fromProvider,
                    toProvider,
                    isStream,
                    originalRequest: originalRequestBody,
                    processedRequest: processedRequestBody
                });
            }

            setImmediate(() => {
                const hasConversion = JSON.stringify(originalRequestBody) !== JSON.stringify(processedRequestBody);
                logger.info(`[AI Monitor][${traceRequestId}] >>> Req Protocol: ${fromProvider}${hasConversion ? ' -> ' + toProvider : ''} | Model: ${model}`);
                
                if (hasConversion) {
                    logger.info(`[AI Monitor][${traceRequestId}] [Req Original]: ${JSON.stringify(originalRequestBody)}`);
                    logger.info(`[AI Monitor][${traceRequestId}] [Req Processed]: ${JSON.stringify(processedRequestBody)}`);
                } else {
                    logger.info(`[AI Monitor][${traceRequestId}] [Req]: ${JSON.stringify(originalRequestBody)}`);
                }
            });

            // 处理流式响应的聚合输出
            if (isStream && traceRequestId) {
                setTimeout(() => {
                    const cache = aiMonitorPlugin.streamCache.get(traceRequestId);
                    if (cache) {
                        const hasConversion = JSON.stringify(cache.nativeChunks) !== JSON.stringify(cache.convertedChunks);
                        logger.info(`[AI Monitor][${traceRequestId}] <<< Stream Response Aggregated: ${hasConversion ? cache.toProvider + ' -> ' : ''}${cache.fromProvider}`);
                        
                        if (hasConversion) {
                            logger.info(`[AI Monitor][${traceRequestId}] [Res Native Full]: ${JSON.stringify(cache.nativeChunks)}`);
                            logger.info(`[AI Monitor][${traceRequestId}] [Res Converted Full]: ${JSON.stringify(cache.convertedChunks)}`);
                        } else {
                            logger.info(`[AI Monitor][${traceRequestId}] [Res Full]: ${JSON.stringify(cache.nativeChunks)}`);
                        }
                        
                        // 流式请求：把聚合后的原生/转换后 chunk 一起落库
                        aiMonitorPlugin.persist(traceRequestId, {
                            nativeResponse: cache.nativeChunks,
                            clientResponse: cache.convertedChunks,
                            fromProvider: cache.fromProvider,
                            toProvider: cache.toProvider,
                            isStream: true
                        });
                        aiMonitorPlugin.streamCache.delete(traceRequestId);
                    }
                }, 2000); // 等待流传输完成
            }
        },

        /**
         * 非流式响应转换监控
         */
        async onUnaryResponse({ nativeResponse, clientResponse, fromProvider, toProvider, requestId }) {
            // 一元请求：请求+响应都已就绪，直接整条落库
            aiMonitorPlugin.persist(requestId, {
                nativeResponse,
                clientResponse,
                fromProvider,
                toProvider
            });
            setImmediate(() => {
                const reqId = requestId || 'N/A';
                const hasConversion = JSON.stringify(nativeResponse) !== JSON.stringify(clientResponse);
                logger.info(`[AI Monitor][${reqId}] <<< Res Protocol: ${hasConversion ? toProvider + ' -> ' : ''}${fromProvider} (Unary)`);
                
                if (hasConversion) {
                    logger.info(`[AI Monitor][${reqId}] [Res Native]: ${JSON.stringify(nativeResponse)}`);
                    logger.info(`[AI Monitor][${reqId}] [Res Converted]: ${JSON.stringify(clientResponse)}`);
                } else {
                    logger.info(`[AI Monitor][${reqId}] [Res]: ${JSON.stringify(nativeResponse)}`);
                }
            });
        },

        /**
         * 流式响应分块转换监控 - 聚合数据
         */
        async onStreamChunk({ nativeChunk, chunkToSend, fromProvider, toProvider, requestId }) {
            if (!requestId) return;

            if (!aiMonitorPlugin.streamCache.has(requestId)) {
                aiMonitorPlugin.streamCache.set(requestId, {
                    nativeChunks: [],
                    convertedChunks: [],
                    fromProvider,
                    toProvider
                });
            }

            const cache = aiMonitorPlugin.streamCache.get(requestId);
            
            // 过滤 null 值，并判断是否为数组类型
            if (nativeChunk != null) {
                if (Array.isArray(nativeChunk)) {
                    cache.nativeChunks.push(...nativeChunk.filter(item => item != null));
                } else {
                    cache.nativeChunks.push(nativeChunk);
                }
            }
            
            if (chunkToSend != null) {
                if (Array.isArray(chunkToSend)) {
                    cache.convertedChunks.push(...chunkToSend.filter(item => item != null));
                } else {
                    cache.convertedChunks.push(chunkToSend);
                }
            }
        },

        /**
         * 内部请求转换监控
         */
        async onInternalRequestConverted({ requestId, internalRequest, converterName }) {
            setImmediate(() => {
                const reqId = requestId || 'N/A';
                logger.info(`[AI Monitor][${reqId}] >>> Internal Req Converted [${converterName}]: ${JSON.stringify(internalRequest)}`);
            });
        }
    },

    /**
     * 查询 API（管理端鉴权由路由层处理）。
     * 提供只读查询 + 清空，方便外部工具或直接 curl 排查。
     */
    routes: [
        {
            // handler 签名：(method, path, req, res, config) —— 见 plugin-manager.ts:536
            path: '/api/ai-monitor/summary',
            method: 'GET',
            handler: async (method, path, req, res) => {
                const { querySummary } = await import('./monitor-db.js');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, data: querySummary() }));
            }
        },
        {
            path: '/api/ai-monitor/records',
            method: 'GET',
            handler: async (method, path, req, res) => {
                const { queryRecords } = await import('./monitor-db.js');
                const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
                const q = url.searchParams;
                const data = queryRecords({
                    model: q.get('model') || undefined,
                    requestId: q.get('requestId') || undefined,
                    from: q.get('from') || undefined,
                    to: q.get('to') || undefined,
                    limit: q.get('limit') ? Number(q.get('limit')) : undefined,
                    offset: q.get('offset') ? Number(q.get('offset')) : undefined
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, data }));
            }
        },
        {
            path: '/api/ai-monitor/records',
            method: 'DELETE',
            handler: async (method, path, req, res) => {
                const { clearRecords } = await import('./monitor-db.js');
                clearRecords();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: '监控记录已清空' }));
            }
        }
    ]
};

export default aiMonitorPlugin;
