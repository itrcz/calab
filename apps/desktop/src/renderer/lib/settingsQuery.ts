/**
 * The settings search text on the phone: the list and a section are different screens (ADR-0073),
 * so the text lives outside the component while a window is open. Reset when its window closes.
 */
let query = '';

export const getSettingsQuery = (): string => query;
export const setSettingsQuery = (q: string): void => {
  query = q;
};
