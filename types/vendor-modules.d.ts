// Minimal ambient declarations for runtime dependencies that do not ship types.
// These keep the strict ratchet focused on first-party code instead of failing on
// untyped third-party packages.

declare module 'adm-zip';
declare module 'busboy';
