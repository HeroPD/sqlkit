import { createWriteStream, type WriteStream } from 'node:fs'
import { chmod, realpath, rename, stat, unlink } from 'node:fs/promises'
import { once } from 'node:events'
import { tempSavePath } from '../files'
import { createExportSerializer, type ExportFormat, type ExportSerializer, type SqlExportTarget } from '../../src/result-export'
import { t } from '../../src/i18n'

// Writes a streamed result to disk with real backpressure: each chunk of rows is
// serialized and written, and when the OS buffer fills the driver's `rows()`
// call resolves only once the stream drains — so a huge export never holds more
// than one chunk plus the write buffer in memory. Column names must be supplied
// (via columns()) before the first rows() call so the header lands first.
export type ExportWriter = {
  /** `jsonColumns`: result positions the driver knows hold JSON documents —
   * the JSON format splices those cells in raw instead of quoting them. */
  columns(names: string[], jsonColumns?: ReadonlySet<number>): void
  rows(chunk: unknown[][]): Promise<void>
  close(): Promise<{ rowCount: number }>
}

// Writes an export to a fresh temp file beside `target` and renames it over the
// target only once `write` succeeds, so a failed or cancelled export leaves the file it would replace untouched.
export async function writeExportAtomically<T>(target: string, write: (tempPath: string) => Promise<T>): Promise<T> {
  // A symlink is replaced at its destination, not swapped for a regular file.
  const resolved = await realpath(target).catch(() => target)
  const existing = await stat(resolved).catch(() => null)
  const temp = tempSavePath(resolved)
  try {
    const result = await write(temp)
    // A fresh temp file takes the umask's mode; the file it replaces keeps its own.
    if (existing) await chmod(temp, existing.mode & 0o7777)
    await rename(temp, resolved)
    return result
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

// `filePath` is created exclusively ('wx'): writers only ever fill the temp file of writeExportAtomically.
export function openExportWriter(filePath: string, format: ExportFormat, sqlTarget?: SqlExportTarget): ExportWriter {
  const stream: WriteStream = createWriteStream(filePath, { encoding: 'utf8', flags: 'wx' })
  // A stream 'error' (disk full, permission) may arrive between writes; capture
  // it so the next call throws instead of hanging on a drain that never comes.
  let failure: Error | null = null
  stream.on('error', (error: Error) => { failure = error })

  let serializer: ExportSerializer | null = null
  let headerWritten = false
  let rowCount = 0

  const write = async (text: string) => {
    if (failure) throw failure
    if (!text) return
    // write() returns false when the buffer is full; once() rejects if the
    // stream emits 'error' while we wait for 'drain'.
    if (!stream.write(text)) await once(stream, 'drain')
  }

  const ensureHeader = async () => {
    if (headerWritten || !serializer) return
    headerWritten = true
    await write(serializer.header())
  }

  return {
    columns(names, jsonColumns) {
      serializer = createExportSerializer(names, format, sqlTarget, jsonColumns)
    },
    async rows(chunk) {
      if (!serializer) throw new Error(t('export.columnsMissing'))
      await ensureHeader()
      let buffer = ''
      for (const row of chunk) {
        buffer += serializer.row(row)
        rowCount += 1
      }
      await write(buffer)
    },
    async close() {
      // Even an empty result writes a header (and JSON's []), so the file is
      // always a valid, openable document.
      await ensureHeader()
      if (serializer) await write(serializer.footer())
      await new Promise<void>((resolve, reject) => {
        if (failure) return reject(failure)
        stream.end((error?: Error | null) => (error ? reject(error) : resolve()))
      })
      return { rowCount }
    },
  }
}
