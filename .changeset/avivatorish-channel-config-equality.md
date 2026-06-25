---
"@spatialdata/avivatorish": patch
---

Export `channelConfigsEqual` and `serializeChannelConfig` for an order-stable channel-config identity. `serializeChannelConfig` produces a canonical string that is independent of object-key insertion order — the `selections` rows are normalized to a fixed `[z, c, t]` order — giving consumers a single shared basis for channel-config equality and identity keys instead of a fragile `JSON.stringify`.
