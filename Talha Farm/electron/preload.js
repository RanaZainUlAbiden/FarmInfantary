const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Database operations
  dbRun: (sql, params) => ipcRenderer.invoke('db-run', sql, params),
  dbGet: (sql, params) => ipcRenderer.invoke('db-get', sql, params),

  // Atomic multi-statement write: one BEGIN/COMMIT, one write to disk
  dbRunBatch: (ops) => ipcRenderer.invoke('db-run-batch', ops),

  // Transaction spanning several calls — always pair a begin with a commit or
  // a rollback, or the writes never reach disk
  dbBeginTransaction: () => ipcRenderer.invoke('db-begin-transaction'),
  dbCommitTransaction: () => ipcRenderer.invoke('db-commit-transaction'),
  dbRollbackTransaction: () => ipcRenderer.invoke('db-rollback-transaction'),

  // System information
  getMachineId: () => ipcRenderer.invoke('get-machine-id'),

  // App settings (used for the delete-code PIN)
  getAppSetting: (farmId, key) => ipcRenderer.invoke('get-app-setting', farmId, key),
  setAppSetting: (farmId, key, value) => ipcRenderer.invoke('set-app-setting', farmId, key, value),

  // Database backup / restore
  backupDatabase: () => ipcRenderer.invoke('backup-database'),
  restoreDatabase: () => ipcRenderer.invoke('restore-database'),

  getAutoBackupPath: () => ipcRenderer.invoke('get-auto-backup-path'),
resetAutoBackupPath: () => ipcRenderer.invoke('reset-auto-backup-path'),

  // PDF printing (opens native OS print dialog)
  printPdfBase64: (base64Data) => ipcRenderer.invoke('print-pdf-base64', base64Data),
  // License operations
  license: {
    getActivation: () => ipcRenderer.invoke('license-get'),
    startTrial: (machineId, date) => ipcRenderer.invoke('license-start-trial', machineId, date),
    activate: (machineId, code) => ipcRenderer.invoke('license-activate', machineId, code),
    updateLastLaunch: (machineId, date) => ipcRenderer.invoke('license-update-launch', machineId, date),
    getStatus: () => ipcRenderer.invoke('license-status')
  },

  // Auto-updater
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update_available', () => callback())
  },
  onUpdateDownloaded: (callback) => {
    ipcRenderer.on('update_downloaded', () => callback())
  },
  restartApp: () => {
    ipcRenderer.send('restart_app')
  }
})