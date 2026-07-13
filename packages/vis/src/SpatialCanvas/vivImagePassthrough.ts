import type { ChannelConfig } from './types';

/** Context passed to Viv image extension / props resolvers (runtime attachments). */
export type VivImageLayerContext = {
  layerId: string;
  elementKey: string;
  channelCount: number;
  loader: unknown;
  channels: ChannelConfig;
};

export type VivImageExtensionResolver = (ctx: VivImageLayerContext) => unknown[] | undefined;

export type VivImagePropsResolver = (
  ctx: VivImageLayerContext
) => Record<string, unknown> | undefined;

export type VivImagePassthroughOptions = {
  /** Global fallback LayerExtension instances when per-layer resolver returns nothing. */
  vivImageExtensions?: unknown[];
  vivImageExtensionResolver?: VivImageExtensionResolver;
  vivImagePropsResolver?: VivImagePropsResolver;
};

export function mergeVivImagePassthroughProps(
  savedProps: Record<string, unknown> | undefined,
  resolvedProps: Record<string, unknown> | undefined,
  resolvedExtensions: unknown[] | undefined,
  globalExtensions: unknown[] | undefined
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...(savedProps ?? {}),
    ...(resolvedProps ?? {}),
  };
  const extensions = resolvedExtensions ?? globalExtensions;
  if (extensions !== undefined && extensions.length > 0) {
    merged.extensions = extensions;
  }
  return merged;
}
