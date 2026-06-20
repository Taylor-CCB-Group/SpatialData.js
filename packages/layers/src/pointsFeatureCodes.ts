export function featureCodesSignature(featureCodes: readonly number[] | undefined): string {
  if (featureCodes === undefined) {
    return 'all';
  }
  if (featureCodes.length === 0) {
    return 'none';
  }
  return featureCodes.slice().sort((left, right) => left - right).join(',');
}

export function preloadedFeatureCodesSignature(
  featureCodes: ArrayLike<number> | undefined
): string {
  if (!featureCodes) {
    return 'nocodes';
  }
  const length = featureCodes.length;
  if (length === 0) {
    return 'len:0';
  }
  return `len:${length}:${featureCodes[0]}:${featureCodes[length - 1]}`;
}

export function filterBatchSignature(
  featureCodes: readonly number[] | undefined,
  preloadedFeatureCodes: ArrayLike<number> | undefined
): string {
  return `${featureCodesSignature(featureCodes)}|${preloadedFeatureCodesSignature(preloadedFeatureCodes)}`;
}
