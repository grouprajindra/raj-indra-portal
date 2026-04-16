/* ========================================
   Raj Indra Group — Database Layer v4.0
   Firebase Firestore (Cloud) + LocalStorage (Cache)
   + Google Sheets Sync + Real Email
   ======================================== */

const DB = {
    // LocalStorage Keys (used as local cache)
    USERS: 'rig_users',
    LEADS: 'rig_leads',
    INVOICES: 'rig_invoices',
    APPROVALS: 'rig_approvals',
    NOTIFICATIONS: 'rig_notifications',
    SESSION: 'rig_session',
    COUNTER: 'rig_counter',
    CONFIG: 'rig_config',

    // Google Sheets Config
    SHEETS_URL: '',

    // Firebase / Firestore
    _fb: null,           // Firestore instance
    _fbReady: false,     // Is Firestore connected?

    // Sync queue for Google Sheets
    _syncQueue: [],
    _isSyncing: false,

    // Collection mapping: localStorage key → Firestore collection name
    _collections: {
        'rig_users': 'users',
        'rig_leads': 'leads',
        'rig_invoices': 'invoices',
        'rig_approvals': 'approvals',
        'rig_notifications': 'notifications'
    },

    // ==========================================
    //  INIT
    // ==========================================
    init() {
        // 1. Initialize localStorage with defaults (if first time)
        if (!localStorage.getItem(this.USERS)) {
            const admin = {
                id: 'USR001',
                employeeId: 'RIG-ADMIN-001',
                name: 'Admin',
                email: 'admin@rajindra.com',
                phone: '+91 98765 00000',
                password: 'admin123',
                role: 'admin',
                status: 'approved',
                photo: '',
                address: 'Head Office, New Delhi',
                aadhar: '',
                pan: '',
                bankName: '',
                bankAccount: '',
                ifsc: '',
                designation: 'Managing Director',
                department: 'Management',
                joinDate: '2024-01-01',
                createdAt: new Date().toISOString()
            };
            localStorage.setItem(this.USERS, JSON.stringify([admin]));
        }
        if (!localStorage.getItem(this.LEADS)) localStorage.setItem(this.LEADS, JSON.stringify([]));
        if (!localStorage.getItem(this.INVOICES)) localStorage.setItem(this.INVOICES, JSON.stringify([]));
        if (!localStorage.getItem(this.APPROVALS)) localStorage.setItem(this.APPROVALS, JSON.stringify([]));
        if (!localStorage.getItem(this.NOTIFICATIONS)) localStorage.setItem(this.NOTIFICATIONS, JSON.stringify([]));
        if (!localStorage.getItem(this.COUNTER)) localStorage.setItem(this.COUNTER, JSON.stringify({ user: 1, lead: 0, invoice: 0, approval: 0 }));

        // 2. Load Google Sheets URL from config
        const config = JSON.parse(localStorage.getItem(this.CONFIG) || '{}');
        this.SHEETS_URL = config.sheetsUrl || '';

        // 3. Process Google Sheets sync queue
        this._loadSyncQueue();
        if (this._syncQueue.length > 0) {
            this._processSyncQueue();
        }

        // 4. Initialize Firebase (async — doesn't block page load)
        this._initFirebase();
    },

    // ==========================================
    //  FIREBASE FIRESTORE INTEGRATION
    // ==========================================
    async _initFirebase() {
        // Check if Firebase SDK is loaded and app is initialized
        if (typeof firebase === 'undefined' || !firebase.apps || !firebase.apps.length) {
            console.log('ℹ️ Firebase not configured. Data stays in this browser only.');
            return;
        }

        try {
            this._fb = firebase.firestore();
            this._fbReady = true;
            console.log('🔥 Firebase Firestore connected! Cloud sync active.');

            // Pull all cloud data into localStorage
            await this._fbPull();

            // Signal UI to refresh with cloud data
            window.dispatchEvent(new CustomEvent('db-synced'));

            // Auto-sync: pull from Firestore every 30 seconds
            setInterval(() => {
                this._fbPull().then(() => {
                    window.dispatchEvent(new CustomEvent('db-synced'));
                });
            }, 30000);

            // Also sync when user switches back to this tab
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden && this._fbReady) {
                    this._fbPull().then(() => {
                        window.dispatchEvent(new CustomEvent('db-synced'));
                    });
                }
            });

        } catch (e) {
            console.warn('Firebase init error:', e);
        }
    },

    // Pull ALL data from Firestore → localStorage
    async _fbPull() {
        if (!this._fbReady) return;
        try {
            for (const [lsKey, collName] of Object.entries(this._collections)) {
                const snap = await this._fb.collection(collName).get();
                if (!snap.empty) {
                    const cloudItems = snap.docs.map(doc => doc.data());
                    
                    // Merge: cloud data is source of truth, but keep local-only items too
                    const localItems = JSON.parse(localStorage.getItem(lsKey) || '[]');
                    const cloudIds = new Set(cloudItems.map(i => i.id));
                    
                    // Items that exist locally but not in cloud (just added offline)
                    const localOnlyItems = localItems.filter(i => !cloudIds.has(i.id));
                    
                    // Merged: cloud items + local-only items
                    const merged = [...cloudItems, ...localOnlyItems];
                    localStorage.setItem(lsKey, JSON.stringify(merged));
                    
                    // Push local-only items to Firestore
                    for (const item of localOnlyItems) {
                        if (item.id) {
                            this._fb.collection(collName).doc(item.id).set(item, { merge: true })
                                .catch(() => {});
                        }
                    }
                }
            }

            // Sync counters: take the MAX to prevent ID reuse
            const counterDoc = await this._fb.collection('_config').doc('counters').get();
            const localCounters = JSON.parse(localStorage.getItem(this.COUNTER) || '{}');
            if (counterDoc.exists) {
                const fbCounters = counterDoc.data();
                const merged = {};
                for (const key of ['user', 'lead', 'invoice', 'approval']) {
                    merged[key] = Math.max(fbCounters[key] || 0, localCounters[key] || 0);
                }
                localStorage.setItem(this.COUNTER, JSON.stringify(merged));
                // Push merged counters back
                this._fb.collection('_config').doc('counters').set(merged).catch(() => {});
            } else {
                // First time: push local counters to Firestore
                this._fb.collection('_config').doc('counters').set(localCounters).catch(() => {});
            }

            // Sync config (sheets URL etc)
            const configDoc = await this._fb.collection('_config').doc('settings').get();
            if (configDoc.exists) {
                const fbConfig = configDoc.data();
                localStorage.setItem(this.CONFIG, JSON.stringify(fbConfig));
                this.SHEETS_URL = fbConfig.sheetsUrl || '';
            }

            console.log('☁️ Cloud sync complete');
        } catch (e) {
            console.warn('Cloud sync failed:', e.message);
        }
    },

    // Push single item to Firestore
    _fbPush(lsKey, item) {
        if (!this._fbReady) return;
        const collName = this._collections[lsKey];
        if (!collName || !item || !item.id) return;

        // Clean copy for Firestore (remove undefined values)
        const cleanItem = {};
        for (const [k, v] of Object.entries(item)) {
            if (v !== undefined) cleanItem[k] = v;
        }

        this._fb.collection(collName).doc(item.id).set(cleanItem, { merge: true })
            .catch(e => console.warn('Cloud push error:', e.message));
    },

    // Delete from Firestore
    _fbDelete(lsKey, id) {
        if (!this._fbReady) return;
        const collName = this._collections[lsKey];
        if (!collName) return;
        this._fb.collection(collName).doc(id).delete()
            .catch(e => console.warn('Cloud delete error:', e.message));
    },

    // Sync counters to Firestore
    _fbSyncCounters() {
        if (!this._fbReady) return;
        try {
            const counters = JSON.parse(localStorage.getItem(this.COUNTER) || '{}');
            this._fb.collection('_config').doc('counters').set(counters).catch(() => {});
        } catch (e) {}
    },

    // ==========================================
    //  GOOGLE SHEETS INTEGRATION
    // ==========================================
    setSheetsUrl(url) {
        const config = JSON.parse(localStorage.getItem(this.CONFIG) || '{}');
        config.sheetsUrl = url;
        localStorage.setItem(this.CONFIG, JSON.stringify(config));
        this.SHEETS_URL = url;
        // Also save to Firestore config
        if (this._fbReady) {
            this._fb.collection('_config').doc('settings').set(config, { merge: true }).catch(() => {});
        }
    },

    getSheetsUrl() {
        return this.SHEETS_URL;
    },

    // Google Apps Script fetch (mode: no-cors for reliable delivery)
    async _postToSheets(data) {
        if (!this.SHEETS_URL) return { success: false, message: 'Google Sheets URL not configured' };

        try {
            await fetch(this.SHEETS_URL, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify(data)
            });
            return { success: true, message: 'Data sent to Google Sheets' };
        } catch (err) {
            console.error('Sheets API error:', err);
            return { success: false, message: 'Network error: ' + err.message };
        }
    },

    // Test connection (GET works without CORS issues)
    async testConnection() {
        if (!this.SHEETS_URL) return { success: false, message: 'Google Sheets URL not set' };
        try {
            const response = await fetch(this.SHEETS_URL, { redirect: 'follow' });
            if (response.ok) {
                try {
                    const data = await response.json();
                    return { success: true, message: 'Connected! ' + (data.message || ''), sheetUrl: data.sheetUrl || '' };
                } catch (e) {
                    return { success: true, message: 'Connected! (Response received)' };
                }
            }
            return { success: false, message: 'Server returned status ' + response.status };
        } catch (err) {
            return { success: false, message: 'Connection test failed: ' + err.message };
        }
    },

    // Single record sync
    async syncToSheets(sheetName, data) {
        const result = await this._postToSheets({ action: 'sync', sheet: sheetName, data: data });
        if (!result.success && result.message && result.message.indexOf('Network') > -1) {
            this._addToSyncQueue({ action: 'sync', sheet: sheetName, data: data });
        }
        return result;
    },

    // Full sync all data
    async syncAllToSheets() {
        if (!this.SHEETS_URL) return { success: false, message: 'Google Sheets URL not configured' };

        const allData = {
            action: 'syncAll',
            employees: this.getAll(this.USERS).map(u => {
                const { password, photo, ...safe } = u;
                return safe;
            }),
            leads: this.getAll(this.LEADS),
            invoices: this.getAll(this.INVOICES),
            approvals: this.getAll(this.APPROVALS)
        };

        return await this._postToSheets(allData);
    },

    // Sync Queue (offline resilience for Google Sheets)
    _loadSyncQueue() {
        try {
            this._syncQueue = JSON.parse(localStorage.getItem('rig_sync_queue') || '[]');
        } catch (e) {
            this._syncQueue = [];
        }
    },

    _saveSyncQueue() { localStorage.setItem('rig_sync_queue', JSON.stringify(this._syncQueue)); },

    _addToSyncQueue(data) {
        this._syncQueue.push({ data: data, timestamp: Date.now() });
        this._saveSyncQueue();
    },

    async _processSyncQueue() {
        if (this._isSyncing || !this.SHEETS_URL || this._syncQueue.length === 0) return;
        this._isSyncing = true;
        const failedItems = [];
        for (const item of this._syncQueue) {
            const result = await this._postToSheets(item.data);
            if (!result.success && Date.now() - item.timestamp < 86400000) {
                failedItems.push(item);
            }
        }
        this._syncQueue = failedItems;
        this._saveSyncQueue();
        this._isSyncing = false;
    },

    // Auto-sync to Google Sheets (debounced 2s)
    _autoSync() {
        if (this._autoSyncTimer) clearTimeout(this._autoSyncTimer);
        this._autoSyncTimer = setTimeout(() => {
            this.syncAllToSheets().then(result => {
                if (result.success) console.log('✅ Auto-synced to Google Sheets');
            });
        }, 2000);
    },

    // ==========================================
    //  REAL EMAIL via Google Apps Script
    // ==========================================
    async sendEmail(toEmail, toName, subject, body) {
        if (!this.SHEETS_URL) {
            this._simulateEmail(toEmail, toName, subject, body);
            return { success: false, message: 'Email stored locally (Google Sheets URL not configured)' };
        }

        try {
            const result = await this._postToSheets({
                action: 'sendEmail',
                to: toEmail,
                toName: toName,
                subject: subject,
                body: body
            });
            this._simulateEmail(toEmail, toName, subject, body);
            return result;
        } catch (err) {
            this._simulateEmail(toEmail, toName, subject, body);
            return { success: false, message: 'Email queued locally: ' + err.message };
        }
    },

    _simulateEmail(toEmail, toName, subject, body) {
        console.log(`📧 EMAIL to ${toEmail}:\nSubject: ${subject}\nBody: ${body}`);
        const emailLog = JSON.parse(localStorage.getItem('rig_emails') || '[]');
        emailLog.push({ to: toEmail, toName: toName, subject, body, sentAt: new Date().toISOString() });
        localStorage.setItem('rig_emails', JSON.stringify(emailLog));
    },

    getEmailLog() {
        return JSON.parse(localStorage.getItem('rig_emails') || '[]').sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
    },

    // Legacy compatibility
    simulateEmail(userId, subject, body) {
        const user = this.getById(this.USERS, userId);
        if (!user) return;
        this.sendEmail(user.email, user.name, subject, body);
    },

    // ==========================================
    //  ID GENERATION
    // ==========================================
    nextId(type) {
        const counters = JSON.parse(localStorage.getItem(this.COUNTER));
        counters[type]++;
        localStorage.setItem(this.COUNTER, JSON.stringify(counters));
        this._fbSyncCounters(); // Also sync counter to cloud
        const prefixes = { user: 'USR', lead: 'LEAD', invoice: 'INV', approval: 'APR' };
        return `${prefixes[type]}${String(counters[type]).padStart(3, '0')}`;
    },

    nextEmployeeId() {
        const users = this.getAll(this.USERS);
        const empIds = users
            .filter(u => u.role === 'employee' && u.employeeId)
            .map(u => {
                const match = u.employeeId.match(/RIG-EMP-(\d+)/);
                return match ? parseInt(match[1]) : 0;
            });
        const maxNum = empIds.length > 0 ? Math.max(...empIds) : 0;
        return `RIG-EMP-${String(maxNum + 1).padStart(3, '0')}`;
    },

    // ==========================================
    //  PHOTO MANAGEMENT
    // ==========================================
    async processPhoto(file) {
        return new Promise((resolve, reject) => {
            if (!file) { resolve(''); return; }

            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const MAX_SIZE = 300;
                    let width = img.width;
                    let height = img.height;

                    if (width > height) {
                        if (width > MAX_SIZE) { height *= MAX_SIZE / width; width = MAX_SIZE; }
                    } else {
                        if (height > MAX_SIZE) { width *= MAX_SIZE / height; height = MAX_SIZE; }
                    }

                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    const compressed = canvas.toDataURL('image/jpeg', 0.7);
                    resolve(compressed);
                };
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = e.target.result;
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    },

    // ==========================================
    //  CRUD OPERATIONS (localStorage + Firestore)
    // ==========================================
    getAll(key) {
        return JSON.parse(localStorage.getItem(key) || '[]');
    },

    getById(key, id) {
        return this.getAll(key).find(item => item.id === id);
    },

    add(key, item) {
        const items = this.getAll(key);
        items.push(item);
        localStorage.setItem(key, JSON.stringify(items));
        this._fbPush(key, item);   // → Cloud
        this._autoSync();          // → Google Sheets
        return item;
    },

    update(key, id, updates) {
        const items = this.getAll(key);
        const idx = items.findIndex(item => item.id === id);
        if (idx > -1) {
            items[idx] = { ...items[idx], ...updates, updatedAt: new Date().toISOString() };
            localStorage.setItem(key, JSON.stringify(items));
            this._fbPush(key, items[idx]);  // → Cloud
            this._autoSync();               // → Google Sheets
            return items[idx];
        }
        return null;
    },

    delete(key, id) {
        const items = this.getAll(key).filter(item => item.id !== id);
        localStorage.setItem(key, JSON.stringify(items));
        this._fbDelete(key, id);  // → Cloud
        this._autoSync();         // → Google Sheets
    },

    // ==========================================
    //  AUTH
    // ==========================================
    login(email, password) {
        const users = this.getAll(this.USERS);
        const user = users.find(u => u.email === email && u.password === password);
        if (!user) return { success: false, message: 'Invalid email or password' };
        if (user.status === 'pending') return { success: false, message: 'Your account is pending approval. Please wait for admin confirmation.' };
        if (user.status === 'rejected') return { success: false, message: 'Your registration has been rejected. Contact admin.' };
        localStorage.setItem(this.SESSION, JSON.stringify({ userId: user.id, role: user.role, loginTime: new Date().toISOString() }));
        return { success: true, user };
    },

    getSession() {
        const session = JSON.parse(localStorage.getItem(this.SESSION));
        if (!session) return null;
        return { ...session, user: this.getById(this.USERS, session.userId) };
    },

    logout() {
        localStorage.removeItem(this.SESSION);
    },

    // ==========================================
    //  REGISTER NEW EMPLOYEE
    // ==========================================
    register(data) {
        const users = this.getAll(this.USERS);
        if (users.find(u => u.email === data.email)) {
            return { success: false, message: 'Email already registered' };
        }
        const id = this.nextId('user');
        const employeeId = this.nextEmployeeId();
        const user = {
            id,
            employeeId,
            name: data.name,
            email: data.email,
            phone: data.phone,
            password: data.password,
            role: 'employee',
            status: 'pending',
            photo: data.photo || '',
            address: data.address || '',
            aadhar: data.aadhar || '',
            pan: data.pan || '',
            bankName: data.bankName || '',
            bankAccount: data.bankAccount || '',
            ifsc: data.ifsc || '',
            designation: data.designation || '',
            department: data.department || '',
            joinDate: new Date().toISOString().split('T')[0],
            createdAt: new Date().toISOString()
        };
        this.add(this.USERS, user);

        // Create approval request
        const approvalId = this.nextId('approval');
        this.add(this.APPROVALS, {
            id: approvalId,
            type: 'registration',
            requestedBy: id,
            requestedByName: data.name,
            description: `New associate registration: ${data.name} (${data.email})`,
            data: user,
            status: 'pending',
            createdAt: new Date().toISOString()
        });

        // Notify admin
        this.addNotification('USR001', `New registration request from ${data.name}`, 'registration');

        // Send email to admin
        const admin = this.getById(this.USERS, 'USR001');
        if (admin && admin.email) {
            this.sendEmail(admin.email, admin.name,
                'New Registration Request',
                `A new associate has requested registration:<br><br><strong>Name:</strong> ${data.name}<br><strong>Email:</strong> ${data.email}<br><strong>Employee ID:</strong> ${employeeId}<br><br>Please review this request in your admin panel.`
            );
        }

        return { success: true, message: `Registration submitted! Your Employee ID: ${employeeId}. Awaiting admin approval.`, employeeId };
    },

    // ==========================================
    //  LEADS
    // ==========================================
    createLead(data) {
        const id = this.nextId('lead');
        const user = data.createdBy ? this.getById(this.USERS, data.createdBy) : null;
        const lead = {
            id,
            clientName: data.clientName,
            clientPhone: data.clientPhone || '',
            clientEmail: data.clientEmail || '',
            service: data.service,
            charges: parseFloat(data.charges) || 0,
            payout: parseFloat(data.payout) || 0,
            assignedTo: data.assignedTo || '',
            assignedToName: data.assignedToName || '',
            status: 'pending',
            approvalStatus: data.createdBy === 'USR001' ? 'approved' : 'pending',
            notes: data.notes || '',
            createdBy: data.createdBy || 'USR001',
            createdAt: new Date().toISOString()
        };

        this.add(this.LEADS, lead);

        // If created by employee, create approval
        if (data.createdBy && data.createdBy !== 'USR001') {
            const approvalId = this.nextId('approval');
            this.add(this.APPROVALS, {
                id: approvalId,
                type: 'lead_update',
                requestedBy: data.createdBy,
                requestedByName: user ? user.name : 'Employee',
                description: `New lead added: ${data.clientName} - ${data.service}`,
                data: { leadId: id, action: 'create', ...lead },
                status: 'pending',
                createdAt: new Date().toISOString()
            });
            this.addNotification('USR001', `${user?.name} added a new lead: ${data.clientName}`, 'lead');
        }

        // Send email to assigned employee
        if (data.assignedTo) {
            const assignee = this.getById(this.USERS, data.assignedTo);
            if (assignee && assignee.email) {
                this.sendEmail(assignee.email, assignee.name,
                    'New Lead Assigned',
                    `A new lead has been assigned to you:<br><br><strong>Client:</strong> ${data.clientName}<br><strong>Service:</strong> ${data.service}<br><strong>Payout:</strong> ₹${lead.payout.toLocaleString()}<br><br>Please check your dashboard for more details.`
                );
            }
        }

        return lead;
    },

    updateLeadStatus(leadId, status, updatedBy) {
        const lead = this.getById(this.LEADS, leadId);
        if (!lead) return null;

        // Employee can directly update lead status (no approval needed)
        this.update(this.LEADS, leadId, { status });

        if (updatedBy && updatedBy !== 'USR001') {
            // Employee updated — notify admin
            const user = this.getById(this.USERS, updatedBy);
            this.addNotification('USR001', `${user?.name} updated lead "${lead.clientName}" to ${status}`, 'lead');
        } else {
            // Admin updated — notify assigned employee
            if (lead.assignedTo) {
                this.addNotification(lead.assignedTo, `Lead "${lead.clientName}" status updated to ${status}`, 'lead');
                const assignee = this.getById(this.USERS, lead.assignedTo);
                if (assignee && assignee.email) {
                    this.sendEmail(assignee.email, assignee.name,
                        `Lead Update: ${lead.clientName}`,
                        `The status of lead "<strong>${lead.clientName}</strong>" has been updated to "<strong>${status}</strong>" by admin.`
                    );
                }
            }
        }
        return { pending: false, message: 'Status updated successfully' };
    },

    // ==========================================
    //  INVOICES
    // ==========================================
    createInvoice(data) {
        const id = this.nextId('invoice');
        const count = this.getAll(this.INVOICES).length;
        const invoice = {
            id,
            invoiceNumber: `RIG-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`,
            type: data.type || 'client',
            clientName: data.clientName || '',
            employeeName: data.employeeName || '',
            employeeId: data.employeeId || '',
            service: data.service || '',
            amount: parseFloat(data.amount) || 0,
            totalAmount: parseFloat(data.totalAmount || data.amount) || 0,
            to: data.to || '',
            notes: data.notes || '',
            status: 'pending',
            date: data.date || new Date().toISOString().split('T')[0],
            createdBy: data.createdBy || 'USR001',
            createdAt: new Date().toISOString()
        };

        this.add(this.INVOICES, invoice);

        // Create approval
        const approvalId = this.nextId('approval');
        this.add(this.APPROVALS, {
            id: approvalId,
            type: 'invoice',
            requestedBy: data.createdBy || 'USR001',
            requestedByName: data.employeeName || 'Admin',
            description: `Invoice ${invoice.invoiceNumber} — ₹${invoice.totalAmount.toLocaleString()}`,
            data: { invoiceId: id, invoiceNumber: invoice.invoiceNumber },
            status: 'pending',
            createdAt: new Date().toISOString()
        });

        return invoice;
    },

    // ==========================================
    //  APPROVALS
    // ==========================================
    processApproval(approvalId, action) {
        const approval = this.getById(this.APPROVALS, approvalId);
        if (!approval) return;

        this.update(this.APPROVALS, approvalId, { status: action, processedAt: new Date().toISOString() });

        const requestUser = this.getById(this.USERS, approval.requestedBy);
        const userName = requestUser ? requestUser.name : approval.requestedByName;
        const userEmail = requestUser ? requestUser.email : null;

        if (approval.type === 'registration') {
            this.update(this.USERS, approval.requestedBy, { status: action === 'approved' ? 'approved' : 'rejected' });
            this.addNotification(approval.requestedBy, `Your registration has been ${action}.`, 'registration');
            if (userEmail) {
                this.sendEmail(userEmail, userName,
                    `Registration ${action.charAt(0).toUpperCase() + action.slice(1)}`,
                    `Dear ${userName},<br><br>Your registration with <strong>Raj Indra Group</strong> has been <strong>${action}</strong>.<br><br>${action === 'approved' ? 'You can now login to the employee portal with your registered credentials.' : 'Please contact the admin for further assistance.'}`
                );
            }
        } else if (approval.type === 'lead_update') {
            if (action === 'approved' && approval.data.newStatus) {
                this.update(this.LEADS, approval.data.leadId, { status: approval.data.newStatus, approvalStatus: 'approved' });
            } else if (action === 'approved' && approval.data.action === 'create') {
                this.update(this.LEADS, approval.data.leadId, { approvalStatus: 'approved' });
            }
            this.addNotification(approval.requestedBy, `Your lead update has been ${action}.`, 'lead');
            if (userEmail) {
                this.sendEmail(userEmail, userName,
                    `Lead Update ${action.charAt(0).toUpperCase() + action.slice(1)}`,
                    `Your lead update request has been <strong>${action}</strong> by admin.`
                );
            }
        } else if (approval.type === 'invoice') {
            if (action === 'approved') {
                this.update(this.INVOICES, approval.data.invoiceId, { status: 'approved' });
            }
            this.addNotification(approval.requestedBy, `Your invoice has been ${action}.`, 'invoice');
            if (userEmail) {
                this.sendEmail(userEmail, userName,
                    `Invoice ${action.charAt(0).toUpperCase() + action.slice(1)}`,
                    `Your invoice <strong>${approval.data.invoiceNumber || ''}</strong> has been <strong>${action}</strong> by admin.`
                );
            }
        } else if (approval.type === 'profile_update') {
            if (action === 'approved') {
                this.update(this.USERS, approval.requestedBy, approval.data.updates);
            }
            this.addNotification(approval.requestedBy, `Your profile update has been ${action}.`, 'profile');
            if (userEmail) {
                this.sendEmail(userEmail, userName,
                    `Profile Update ${action.charAt(0).toUpperCase() + action.slice(1)}`,
                    `Your profile update request has been <strong>${action}</strong> by admin.`
                );
            }
        }
    },

    // ==========================================
    //  NOTIFICATIONS (localStorage + Firestore)
    // ==========================================
    addNotification(userId, message, type) {
        const notif = {
            id: 'NOTIF_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            userId,
            message,
            type,
            read: false,
            createdAt: new Date().toISOString()
        };
        const notifs = this.getAll(this.NOTIFICATIONS);
        notifs.push(notif);
        localStorage.setItem(this.NOTIFICATIONS, JSON.stringify(notifs));
        this._fbPush(this.NOTIFICATIONS, notif); // → Cloud
    },

    getNotifications(userId) {
        return this.getAll(this.NOTIFICATIONS).filter(n => n.userId === userId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },

    markNotificationRead(notifId) {
        const notifs = this.getAll(this.NOTIFICATIONS);
        const idx = notifs.findIndex(n => n.id === notifId);
        if (idx > -1) {
            notifs[idx].read = true;
            localStorage.setItem(this.NOTIFICATIONS, JSON.stringify(notifs));
            this._fbPush(this.NOTIFICATIONS, notifs[idx]); // → Cloud
        }
    },

    getUnreadCount(userId) {
        return this.getNotifications(userId).filter(n => !n.read).length;
    },

    // ==========================================
    //  FINANCIALS
    // ==========================================
    getFinancials(employeeId) {
        const leads = this.getAll(this.LEADS);
        const filtered = employeeId ? leads.filter(l => l.assignedTo === employeeId) : leads;
        const successful = filtered.filter(l => l.status === 'successful');
        const totalRevenue = successful.reduce((s, l) => s + l.charges, 0);
        const totalPayout = successful.reduce((s, l) => s + l.payout, 0);
        const netProfit = totalRevenue - totalPayout;
        const pending = filtered.filter(l => l.status === 'pending').length;
        const inProgress = filtered.filter(l => l.status === 'in-progress').length;
        const denied = filtered.filter(l => l.status === 'denied').length;

        return { totalRevenue, totalPayout, netProfit, totalLeads: filtered.length, successful: successful.length, pending, inProgress, denied };
    },

    // ==========================================
    //  EXPORT
    // ==========================================
    exportCSV(key, filename) {
        const data = this.getAll(key);
        if (!data.length) return;
        const headers = Object.keys(data[0]).filter(h => h !== 'photo' && h !== 'password');
        const csv = [headers.join(','), ...data.map(row => headers.map(h => `"${(row[h] || '').toString().replace(/"/g, '""')}"`).join(','))].join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename || `${key}_export.csv`;
        a.click();
    },

    exportJSON(key, filename) {
        const data = this.getAll(key);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename || `${key}_export.json`;
        a.click();
    }
};

// Initialize on load
DB.init();
