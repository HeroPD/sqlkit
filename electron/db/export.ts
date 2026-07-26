import { createWriteStream, type WriteStream } from 'node:fs'
import { once } from 'node:events'
import { createExportSerializer, type ExportFormat, type ExportSerializer, type SqlExportTarget } from '../../src/result-export'
import { t } from '../../src/i18n'

// Writes a streamed result to disk with real backpressure: each chunk of rows is
// serialized and written, and when the OS buffer fills the driver's `rows()`
// call resolves only once the stream drains — so a huge export never holds more
// than one chunk plus the write buffer in memory. Column names must be supplied
// (via columns()) before the first rows() call so the header lands first.
export type ExportWriter = {
  columns(names: string[]): void
  rows(chunk: unknown[][]): Promise<void>
  close(): Promise<{ rowCount: number }>
}

export function openExportWriter(filePath: string, format: ExportFormat, sqlTarget?: SqlExportTarget): ExportWriter {
  const stream: WriteStream = createWriteStream(filePath, { encoding: 'utf8' })
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
    columns(names) {
      serializer = createExportSerializer(names, format, sqlTarget)
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
