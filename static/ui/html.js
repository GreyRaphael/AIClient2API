/**
 * htm + Preact 统一入口。
 * 业务文件只从这里导入 html 模板与 hooks，避免各处重复绑定。
 */
import { h } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);
export { render, Fragment } from 'preact';
export { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
