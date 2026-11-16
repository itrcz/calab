/**
 * Narrows a number from a true boundary (a `<select>` value, a wire field typed as a plain number)
 * to a protobuf enum. The one place the unchecked assertion lives, so call sites stay clean under
 * `@typescript-eslint/no-unsafe-enum-assignment`. The enum object is only there to infer the type;
 * the value is not validated (the server validates every field again).
 */
export function asEnum<E extends number>(_enumObject: Record<string, E | string>, value: number): E {
  return value as E;
}
