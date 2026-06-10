export type SqlkitApi = {
  versions: {
    electron: string
    chrome: string
    node: string
  }
  ping: () => Promise<string>
}

declare global {
  interface Window {
    sqlkit: SqlkitApi
  }
}
