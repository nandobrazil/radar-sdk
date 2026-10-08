declare const __SDK_VERSION__: string | undefined;

export const SDK_NAME = '@oconde/radar';
export const SDK_VERSION: string = typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : '0.0.0-dev';
