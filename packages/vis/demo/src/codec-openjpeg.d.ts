declare module '@cornerstonejs/codec-openjpeg/decode' {
  const factory: (opts?: {
    locateFile?: (path: string, prefix: string) => string;
  }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  export default factory;
}
