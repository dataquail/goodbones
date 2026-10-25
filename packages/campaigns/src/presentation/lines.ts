// What every presenter writes the same way.

export const count = (n: number, noun: string, plural = `${noun}s`): string =>
  `${String(n)} ${n === 1 ? noun : plural}`;
