const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { machineIdSync } = require('node-machine-id')
const { autoUpdater } = require('electron-updater')
const { initializeDatabase, runQuery, getQuery, runBatch, beginTransaction, commitTransaction, rollbackTransaction } = require('./database')
const fsPromises = require('fs').promises
const os = require('os')

// Windows specific optimizations
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('high-dpi-support', '1')

// Set app name for Windows
app.setAppUserModelId('com.devinfantary.poultry-farm')

let mainWindow
let isQuitting = false

async function createWindow() {
  let dbResult;
  try {
    dbResult = await initializeDatabase()
  } catch (err) {
    console.error('FATAL: Database initialization failed:', err)
    dialog.showErrorBox(
      'Application Error',
      'Failed to start the application.\n\n' +
      'Please try these steps:\n' +
      '1. Restart your computer\n' +
      '2. If the problem persists, contact support\n\n' +
      'Error details: ' + err.message
    )
    app.quit()
    return
  }

  if (dbResult && dbResult.recovered) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'Data Recovery Notice',
      message: 'The application detected and recovered your data from a corrupted database.\n\nPlease verify that all your records are correct.\n\nA backup of the original corrupted file has been saved for safety.',
      buttons: ['OK']
    })
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    backgroundColor: '#f0f4f8',
    show: false,
    icon: path.join(__dirname, '../public/favicon.ico'),
    frame: true,
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    },
    title: 'Talha Protein Farm'
  })

  const indexPath = path.join(__dirname, '../dist/Poultry-Farm/browser/index.html')
  mainWindow.loadFile(indexPath)

  mainWindow.setMenu(null)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    mainWindow.focus()
    mainWindow.maximize()
    
    if (process.env.NODE_ENV === 'production') {
      autoUpdater.checkForUpdatesAndNotify()
    }
  })

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Yes', 'No'],
        title: 'Confirm',
        message: 'Are you sure you want to quit?'
      }).then(async (result) => {
        if (result.response === 0) {
          try {
            await performAutoBackup()
          } catch (e) {
            console.error('Auto-backup failed during quit:', e.message)
          }
          isQuitting = true
          app.quit()
        }
      }).catch((err) => {
        console.error('Quit confirmation dialog failed:', err.message)
      })
    }
    return false
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// ── APP EVENTS ──────────────────────────────────────────────

app.on('renderer-process-crashed', (event, webContents, killed) => {
  console.error('Renderer process crashed:', killed)
  if (mainWindow) {
    dialog.showErrorBox(
      'Application Error',
      'The application encountered an error and will restart.'
    )
    mainWindow.reload()
  }
})

app.on('gpu-process-crashed', (event, killed) => {
  console.error('GPU process crashed:', killed)
})

// ── IPC HANDLERS ────────────────────────────────────────────

ipcMain.handle('db-run', async (event, sql, params) => {
  return runQuery(sql, params)
})

// Runs an ordered list of { sql, params } as one unit: all of it commits or
// none of it does, and the database file is written once instead of once per
// statement. A params entry of { $lastId: n } is replaced with the id inserted
// by operation n of the same batch (n < 0 counts back from the current one),
// so chained inserts never need a round trip to the renderer.
ipcMain.handle('db-run-batch', async (event, ops) => {
  return runBatch(ops)
})

// Transaction spanning several IPC calls, for saves whose next statement
// depends on reading back what the previous ones wrote. The caller MUST commit
// or roll back; anything left open is rolled back automatically after a minute.
ipcMain.handle('db-begin-transaction', async () => {
  return beginTransaction()
})

ipcMain.handle('db-commit-transaction', async () => {
  return commitTransaction()
})

ipcMain.handle('db-rollback-transaction', async () => {
  return rollbackTransaction()
})

ipcMain.handle('get-auto-backup-path', async () => {
  return await getAutoBackupPath()
})

ipcMain.handle('reset-auto-backup-path', async () => {
  await setAutoBackupPath(null)
  return { success: true }
})

const { getAppSetting, setAppSetting } = require('./database')

ipcMain.handle('get-app-setting', async (event, farmId, key) => {
  return getAppSetting(farmId, key)
})
ipcMain.handle('backup-database', async () => {
  try {
    const dbPath = path.join(app.getPath('userData'), 'sng_farm.db')
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Database Backup',
      defaultPath: `sng_farm_backup_${new Date().toISOString().split('T')[0]}.db`,
      filters: [{ name: 'Database Backup', extensions: ['db'] }]
    })
    if (canceled || !filePath) return { success: false, cancelled: true }

    const fs = require('fs')
    fs.copyFileSync(dbPath, filePath)
    return { success: true, path: filePath }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('restore-database', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Database Backup to Restore',
      filters: [{ name: 'Database Backup', extensions: ['db'] }],
      properties: ['openFile']
    })
    if (canceled || !filePaths || filePaths.length === 0) return { success: false, cancelled: true }

    const confirm = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Confirm Restore',
      message: 'This will replace ALL current data with the selected backup.\n\nThis cannot be undone. Continue?',
      buttons: ['Cancel', 'Restore'],
      defaultId: 0,
      cancelId: 0
    })
    if (confirm.response !== 1) return { success: false, cancelled: true }

    const fs = require('fs')
    const dbPath = path.join(app.getPath('userData'), 'sng_farm.db')

    // Safety net: back up the current (about-to-be-replaced) file first
    const safetyPath = dbPath + '.pre-restore.' + Date.now() + '.bak'
    try { fs.copyFileSync(dbPath, safetyPath) } catch (e) {}

    fs.copyFileSync(filePaths[0], dbPath)

    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Restore Complete',
      message: 'Database restored successfully. The application will now restart.',
      buttons: ['OK']
    })

    app.relaunch()
    isQuitting = true
    app.quit()
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('set-app-setting', async (event, farmId, key, value) => {
  return setAppSetting(farmId, key, value)
})
ipcMain.handle('db-get', async (event, sql, params) => {
  return getQuery(sql, params)
})

ipcMain.handle('print-pdf-base64', async (event, base64Data) => {
  const tempPath = path.join(os.tmpdir(), `talha-farm-print-${Date.now()}.pdf`)

  try {
    await fsPromises.writeFile(tempPath, Buffer.from(base64Data, 'base64'))
  } catch (err) {
    return { success: false, error: 'Failed to write temp PDF: ' + err.message }
  }

  return new Promise((resolve) => {
    const previewWindow = new BrowserWindow({
      width: 950,
      height: 1000,
      parent: mainWindow,
      title: 'Print Preview',
      backgroundColor: '#525659',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        plugins: true
      }
    })

    previewWindow.setMenu(null)

    let resolved = false
    const cleanupFile = () => {
      fsPromises.unlink(tempPath).catch(() => {})
    }

    previewWindow.on('closed', () => {
      cleanupFile()
      if (!resolved) {
        resolved = true
        resolve({ success: true })
      }
    })

    previewWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      if (!resolved) {
        resolved = true
        resolve({ success: false, error: errorDescription })
      }
      if (!previewWindow.isDestroyed()) previewWindow.close()
    })

    previewWindow.webContents.on('did-finish-load', () => {
      if (!resolved) {
        resolved = true
        resolve({ success: true })
      }
    })

    previewWindow.loadURL(`file://${tempPath}`)
  })
})

ipcMain.handle('get-machine-id', async () => {
  return machineIdSync()
})

// ═══════════════ LICENSE IPC HANDLERS ═══════════════

const LICENSE_SECRET = 'SNG@PoultryFarm#2024!DevInfantary';

function licenseHashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const hex = Math.abs(hash).toString(16).toUpperCase();
  return hex.padStart(8, '0');
}

// 🔐 Cycle is now baked into the code. Every successful activation
// bumps activation_cycle in the DB, which invalidates the code that
// was just used — client can't replay the same code after it expires.
function generateExpectedCode(machineId, cycle) {
  const combined = machineId + cycle + LICENSE_SECRET;
  const hash = licenseHashCode(combined);
  return `DIP-${hash.slice(0, 4)}-${hash.slice(4, 8)}`;
}

ipcMain.handle('license-get', async () => {
  const machineId = machineIdSync();
  return getQuery('SELECT * FROM activation WHERE machine_id = ?', [machineId]);
});

ipcMain.handle('license-start-trial', async (event, machineId, date) => {
  return runQuery(
    'INSERT OR REPLACE INTO activation (machine_id, activation_code, trial_start_date, last_launch_date, is_permanent, is_active, activation_cycle) VALUES (?, ?, ?, ?, 0, 1, 0)',
    [machineId, '', date, date]
  );
});

ipcMain.handle('license-activate', async (event, machineId, code) => {
  // Get current cycle from DB
  const existing = await getQuery('SELECT * FROM activation WHERE machine_id = ?', [machineId]);
  const row = existing.success && existing.data.length > 0 ? existing.data[0] : null;
  const currentCycle = row && row.activation_cycle !== undefined ? row.activation_cycle : 0;

  // Validate against current cycle
  const expectedCode = generateExpectedCode(machineId, currentCycle);
  if (code.trim().toUpperCase() !== expectedCode) {
    return { success: false, error: 'Invalid activation code' };
  }

  // 🔒 Burn this code — increment cycle so old code never works again
  const now = new Date().toISOString();
  const nextCycle = currentCycle + 1;
  const trialStart = row && row.trial_start_date ? row.trial_start_date : now;

  return runQuery(
    'INSERT OR REPLACE INTO activation (machine_id, activation_code, trial_start_date, last_launch_date, is_permanent, is_active, activated_at, activation_cycle) VALUES (?, ?, ?, ?, 1, 1, ?, ?)',
    [machineId, code, trialStart, now, now, nextCycle]
  );
});

ipcMain.handle('license-update-launch', async (event, machineId, date) => {
  return runQuery('UPDATE activation SET last_launch_date = ? WHERE machine_id = ?', [date, machineId]);
});

// Trials last 7 days. Activated licences never expire — see license-status.
const TRIAL_DAYS = 7;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

// Tolerance for the clock legitimately reading earlier than the last launch:
// NTP corrections, DST, and machines whose RTC is interpreted as local time
// (a timezone correction can move the clock by up to ~26 hours).
const CLOCK_DRIFT_TOLERANCE_MS = 26 * 60 * 60 * 1000;

ipcMain.handle('license-status', async () => {
  const machineId = machineIdSync();
  const result = await getQuery('SELECT * FROM activation WHERE machine_id = ?', [machineId]);
  const row = result.success && result.data.length > 0 ? result.data[0] : null;

  if (!row) {
    return {
      activated: false,
      isPermanent: false,
      trialStarted: false,
      trialExpired: false,
      daysRemaining: TRIAL_DAYS,
      clockTampered: false,
      licenseDaysRemaining: 0,
      activationCycle: 0
    };
  }

  const now = new Date();
  const trialStart = row.trial_start_date ? new Date(row.trial_start_date) : null;
  const lastLaunch = row.last_launch_date ? new Date(row.last_launch_date) : null;
  const activationCycle = row.activation_cycle || 0;

  // ═══════════════ 🔑 PERMANENT LICENSE ═══════════════
  // A redeemed activation code grants a licence that never expires.
  // license-activate only writes activation_code after the code has been
  // verified against the current cycle, so a non-empty code means a genuine
  // redemption. Rows redeemed before is_permanent was honoured still carry 0,
  // and the old 7-day expiry / 48-hour "tamper" rules may already have flipped
  // is_active to 0 on them — those were the only two writes of is_active = 0 in
  // the app, and both are gone — so paid rows are repaired here instead of
  // being left locked out.
  const hasActivationCode = !!(row.activation_code && row.activation_code.length > 0);
  const isPermanent = row.is_permanent === 1 || hasActivationCode;

  if (isPermanent && (row.is_permanent !== 1 || row.is_active !== 1)) {
    await runQuery(
      'UPDATE activation SET is_permanent = 1, is_active = 1 WHERE machine_id = ?',
      [machineId]
    );
  }

  // ═══════════════ 🔒 CLOCK TAMPER DETECTION ═══════════════
  // ONLY a backwards jump counts as tampering. A forward gap — however long —
  // means the user did not open the app (a weekend, a public holiday, a week
  // away), which is not tampering and must never cost them their licence.
  // Nothing on this path writes is_active = 0: the check is recomputed on every
  // call, so putting the clock back right restores access on its own.
  // Permanent licences skip the check entirely — there is no expiry to dodge.
  let clockTampered = false;

  if (lastLaunch && !isPermanent) {
    const setBackMs = lastLaunch.getTime() - now.getTime();
    if (setBackMs > CLOCK_DRIFT_TOLERANCE_MS) {
      clockTampered = true;
    }
  }

  if (clockTampered) {
    return {
      activated: false,
      isPermanent: false,
      trialStarted: !!trialStart,
      trialExpired: true,
      daysRemaining: 0,
      clockTampered: true,
      licenseDaysRemaining: 0,
      activationCycle
    };
  }

  // ═══════════════ CHECK ACTIVATION ═══════════════
  // No expiry countdown: an activated licence is permanent.
  const activated = isPermanent || (row.is_active === 1 && hasActivationCode);

  // ═══════════════ CHECK TRIAL ═══════════════
  // The 7-day window applies to TRIALS ONLY.
  let trialExpired = false;
  let daysRemaining = TRIAL_DAYS;
  let trialStarted = false;

  if (trialStart) {
    trialStarted = true;
    const diffDays = Math.ceil((now.getTime() - trialStart.getTime()) / MS_PER_DAY);
    daysRemaining = TRIAL_DAYS - diffDays;
    trialExpired = !activated && diffDays > TRIAL_DAYS;
  }

  return {
    activated,
    isPermanent,
    trialStarted,
    trialExpired,
    daysRemaining: daysRemaining > 0 ? daysRemaining : 0,
    clockTampered: false,
    licenseDaysRemaining: 0,
    activationCycle
  };
});

// ── AUTO UPDATER ────────────────────────────────────────────

autoUpdater.on('update-available', () => {
  if (mainWindow) {
    mainWindow.webContents.send('update_available')
  }
})

autoUpdater.on('update-downloaded', () => {
  if (mainWindow) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: 'A new version has been downloaded. Restart the application to install the update.',
      buttons: ['Restart Now', 'Later']
    }).then((result) => {
      if (result.response === 0) {
        isQuitting = true
        autoUpdater.quitAndInstall()
      }
    })
  }
})

autoUpdater.on('error', (err) => {
  console.error('Update error:', err)
})

ipcMain.on('restart_app', () => {
  isQuitting = true
  autoUpdater.quitAndInstall()
})

// ── SINGLE INSTANCE ────────────────────────────────────────

// ═══════════════ AUTO BACKUP ON QUIT ═══════════════

function getBackupConfigPath() {
  return path.join(app.getPath('userData'), 'backup-config.json')
}

async function getAutoBackupPath() {
  try {
    const raw = await fsPromises.readFile(getBackupConfigPath(), 'utf-8')
    const config = JSON.parse(raw)
    return config.autoBackupPath || null
  } catch (e) {
    return null
  }
}

async function setAutoBackupPath(backupPath) {
  try {
    await fsPromises.writeFile(getBackupConfigPath(), JSON.stringify({ autoBackupPath: backupPath }), 'utf-8')
  } catch (e) {
    console.error('Failed to save backup config:', e.message)
  }
}

async function performAutoBackup() {
  const dbPath = path.join(app.getPath('userData'), 'sng_farm.db')
  if (!fs.existsSync(dbPath)) return

  let backupPath = await getAutoBackupPath()

  // Check the remembered location is still valid (e.g. USB drive still plugged in)
  if (backupPath) {
    const dir = path.dirname(backupPath)
    if (!fs.existsSync(dir)) {
      backupPath = null
    }
  }

  if (!backupPath) {
    // First time (or previous location vanished) — ask the user to choose.
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Choose Auto-Backup Location',
      defaultPath: `sng_farm_backup.db`,
      filters: [{ name: 'Database Backup', extensions: ['db'] }]
    })
    if (canceled || !filePath) {
      // User declined — skip backup for this close, ask again next time.
      return
    }
    backupPath = filePath
    await setAutoBackupPath(backupPath)
  }

  try {
    await fsPromises.copyFile(dbPath, backupPath)
    console.log('✅ Auto-backup saved to:', backupPath)
    await writeBackupLog(`SUCCESS ${new Date().toISOString()} -> ${backupPath}`)
  } catch (e) {
    console.error('❌ Auto-backup failed:', e.message)
    await writeBackupLog(`FAILED ${new Date().toISOString()} -> ${e.message}`)
  }
}

async function writeBackupLog(line) {
  try {
    const logPath = path.join(app.getPath('userData'), 'backup-log.txt')
    await fsPromises.appendFile(logPath, line + '\n', 'utf-8')
  } catch (e) {
    // Logging itself failing shouldn't crash the quit flow
  }
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
     app.whenReady().then(createWindow)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      isQuitting = true
      app.quit()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}