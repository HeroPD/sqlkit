// ── State & Shared Utilities ─────────────────────────────────────────────────

export const state = {
  engine: 'postgresql',
  connected: false,
  selectedTable: null,
  isConnecting: false,
  isRunning: false,
  expandedTables: new Set(),
  panelTab: 'results',
  messages: [],
  sidebarVisible: true,
  tables: [],
  workspace: null,
  files: [],
  expandedFileFolders: new Set(),
  tabs: [],
  activeTabId: null,
  nextTabId: 1,
  untitledCount: 0,
}

export const ENGINE_DEFAULTS = {
  postgresql: { port: '5432', database: 'postgres', username: 'postgres' },
  mysql:      { port: '3306', database: 'mysql',    username: 'root' },
  sqlserver:  { port: '1433', database: 'master',   username: 'sa' }
}

// ── DOM ──────────────────────────────────────────────────────────────────────

export const $ = id => document.getElementById(id)

export const el = {
  screenWelcome:   $('screen-welcome'),
  screenWorkbench: $('screen-workbench'),
  welcomeOpen:     $('welcome-open'),
  welcomeRecentSection: $('welcome-recent-section'),
  welcomeRecentList:    $('welcome-recent-list'),
  titlebarTitle:   $('titlebar-title'),
  activityItems: document.querySelectorAll('.activity-item'),
  sidebar:       $('sidebar'),
  sectionHeaders: document.querySelectorAll('.section-header'),
  engineBtns:    document.querySelectorAll('.engine-btn'),
  host:          $('host'),
  port:          $('port'),
  database:      $('database'),
  username:      $('username'),
  password:      $('password'),
  connectBtn:    $('connect-btn'),
  refreshBtn:    $('refresh-btn'),
  connStatus:    $('connection-status'),
  fileTree:      $('file-tree'),
  fileEmpty:     $('file-empty'),
  filesSectionTitle: $('files-section-title'),
  newFileBtn:    $('new-file-btn'),
  refreshFilesBtn: $('refresh-files-btn'),
  tableTree:     $('table-tree'),
  tableEmpty:    $('table-empty'),
  tabBar:        $('tab-bar'),
  lineNumbers:   $('line-numbers'),
  queryEditor:   $('query-editor'),
  panelTabs:     document.querySelectorAll('.panel-tab'),
  runBtn:        $('run-btn'),
  resultsPanel:  $('results-panel'),
  messagesPanel: $('messages-panel'),
  resultsEmpty:  $('results-empty'),
  resultsScroll: $('results-scroll'),
  resultsThead:  $('results-thead'),
  resultsTbody:  $('results-tbody'),
  messagesEmpty: $('messages-empty'),
  messagesList:  $('messages-list'),
  statusBar:     $('status-bar'),
  statusConnText:$('status-conn-text'),
  statusInfo:    $('status-info'),
  statusWorkspace: $('status-workspace'),
  saveOverlay:   $('save-overlay'),
  saveInput:     $('save-input'),
  saveCancel:    $('save-cancel'),
  saveConfirm:   $('save-confirm'),
  saveError:     $('save-error'),
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function fmtTime(ms) {
  if (!ms && ms !== 0) return '?'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`
}

export function setConnStatus(msg, cls) {
  el.connStatus.textContent = msg
  el.connStatus.className   = cls
}

export function setStatusConnection(version) {
  el.statusBar.classList.add('connected')
  el.statusConnText.textContent = version
}

export function setStatusDisconnected() {
  el.statusBar.classList.remove('connected')
  el.statusConnText.textContent = 'Disconnected'
  el.statusInfo.textContent = ''
}
