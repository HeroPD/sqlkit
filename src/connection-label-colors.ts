import type { ConnectionLabelColor } from './electron'

export type ConnectionLabelColorOption = {
  id: ConnectionLabelColor
  label: string
  value: string
}

// The label is a title-bar border while live status is a separate dot, so the
// palette can span the color wheel. The hues stay distinct at title-bar scale.
export const CONNECTION_LABEL_COLORS: ReadonlyArray<ConnectionLabelColorOption> = [
  { id: 'accent-01', label: 'Ruby', value: '#b2054c' },
  { id: 'accent-02', label: 'Magenta', value: '#a12a8d' },
  { id: 'accent-03', label: 'Violet', value: '#6b3cb2' },
  { id: 'accent-04', label: 'Indigo', value: '#3f51b5' },
  { id: 'accent-05', label: 'Blue', value: '#1577b5' },
  { id: 'accent-06', label: 'Cyan', value: '#008b9a' },
  { id: 'accent-07', label: 'Teal', value: '#147d64' },
  { id: 'accent-08', label: 'Green', value: '#548735' },
  { id: 'accent-09', label: 'Gold', value: '#b28700' },
  { id: 'accent-10', label: 'Orange', value: '#c45b18' },
]

const COLOR_VALUES = new Map(CONNECTION_LABEL_COLORS.map((color) => [color.id, color.value]))

export const connectionLabelColorValue = (color: ConnectionLabelColor | undefined): string | null =>
  color ? (COLOR_VALUES.get(color) ?? null) : null

export const isConnectionLabelColor = (value: unknown): value is ConnectionLabelColor =>
  typeof value === 'string' && COLOR_VALUES.has(value as ConnectionLabelColor)
