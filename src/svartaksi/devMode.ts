/** Legacy query strings remain valid; all game URLs now expose the same tools. */
export const DEV_MODE_QUERY_PARAMETER = 'dev';
export function isDevModeRequested(search: string): boolean {
  void search;
  return true;
}
