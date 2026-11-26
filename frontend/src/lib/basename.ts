/** The last part of a path, with either separator, since native paths reach the UI as written. */
export const basename = (path: string) => path.split(/[\\/]/).pop() ?? path
