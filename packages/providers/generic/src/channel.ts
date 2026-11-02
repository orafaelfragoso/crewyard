export interface EventChannel<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
  readonly closed: boolean;
}

export function createChannel<T>(): EventChannel<T> {
  const buffer: T[] = [];
  const waiters: ((result: IteratorResult<T>) => void)[] = [];
  let closed = false;
  let iterating = false;

  return {
    get closed() {
      return closed;
    },
    push(value) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else buffer.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      if (iterating) throw new Error('Event stream supports a single consumer');
      iterating = true;
      return {
        next: () => {
          const value = buffer.shift();
          if (value !== undefined) return Promise.resolve({ value, done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return: () => {
          closed = true;
          buffer.length = 0;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}
