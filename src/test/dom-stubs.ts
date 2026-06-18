// CodeMirror measures the DOM; jsdom has no layout engine, so jsdom-based
// tests stub the geometry APIs it touches. Call from beforeAll.
export function stubEditorLayout() {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) })
  Range.prototype.getClientRects = () =>
    (({ length: 0, item: () => null, [Symbol.iterator]: [].values }))
  Element.prototype.scrollIntoView = () => {}
}
