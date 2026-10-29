// 项目级 Babel 配置（babel-jest 使用）。
// 必须是 babel.config.cjs 而不是 .babelrc：.babelrc 只作用于本项目文件，
// 不会作用于 node_modules 中以 ESM 发布的 preact/htm/signals（Jest 需要转换它们）。
module.exports = {
    presets: [
        '@babel/preset-env',
        ['@babel/preset-typescript', { allowDeclareFields: true }]
    ],
    plugins: ['babel-plugin-transform-import-meta']
};
