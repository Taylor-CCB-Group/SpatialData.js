/**
 * An id list that counts how many of its ids are read. A check repeated with the same list
 * (every `getLayers()` of a pan) must read none: it is matched by identity, not by
 * walking or serialising the ids.
 */
export const countingIds = (ids: string[]) => {
  const reads = { count: 0 };
  const list = new Proxy(ids, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads.count++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { list, reads };
};
