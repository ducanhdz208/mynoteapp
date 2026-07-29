const { createApp, ref, computed, onMounted, onUnmounted } = Vue;

const CACHE_KEY = 'personal_notes_cache_v2';
const QUEUE_KEY = 'personal_notes_sync_queue_v2';

createApp({
    setup() {
        const isAuthenticated = ref(false);
        const isLoggingIn = ref(false);
        const passwordInput = ref('');
        const loginError = ref('');
        const notes = ref([]);
        const currentNote = ref(null);
        const isEditing = ref(false);
        const isMobileNoteOpen = ref(false);
        const isOffline = ref(!navigator.onLine);
        const searchQuery = ref('');
        const folderFilter = ref('');
        const selectedTag = ref('');
        const favoritesOnly = ref(false);
        const saveState = ref('saved');
        const historyOpen = ref(false);
        const historyLoading = ref(false);
        const historyVersions = ref([]);
        const toastMessage = ref('');
        const searchInput = ref(null);
        const importInput = ref(null);
        let saveTimeout = null;
        let toastTimeout = null;

        const readCachedNotes = () => {
            try {
                const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
                return Array.isArray(cached) ? cached.map(normalizeNote) : [];
            } catch {
                return [];
            }
        };

        const readQueue = () => {
            try {
                const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
                return Array.isArray(queue) ? queue : [];
            } catch {
                return [];
            }
        };

        const hasCachedNotes = computed(() => readCachedNotes().length > 0);

        const folders = computed(() => [...new Set(
            notes.value.map((note) => note.folder || 'Notes')
        )].sort((a, b) => a.localeCompare(b)));

        const allTags = computed(() => [...new Set(
            notes.value.flatMap((note) => note.tags || [])
        )].sort((a, b) => a.localeCompare(b)));

        const filteredNotes = computed(() => {
            const query = searchQuery.value.trim().toLowerCase();
            return notes.value
                .filter((note) => {
                    const searchable = [
                        note.title,
                        note.content,
                        note.folder,
                        ...(note.tags || [])
                    ].join(' ').toLowerCase();
                    return (!query || searchable.includes(query))
                        && (!folderFilter.value || note.folder === folderFilter.value)
                        && (!selectedTag.value || note.tags.includes(selectedTag.value))
                        && (!favoritesOnly.value || note.favorite);
                })
                .slice()
                .sort((left, right) => {
                    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
                    return new Date(right.updated_at || 0) - new Date(left.updated_at || 0);
                });
        });

        const tagText = computed(() => (currentNote.value?.tags || []).join(', '));

        const saveStatusText = computed(() => ({
            unsaved: 'Unsaved changes',
            saving: 'Saving…',
            saved: 'Saved',
            queued: 'Queued offline',
            error: 'Save failed'
        })[saveState.value] || 'Saved');

        const renderedMarkdown = computed(() => {
            const content = currentNote.value?.content;
            if (!content) return '<em>Start typing...</em>';
            const html = marked.parse(content);
            return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
        });

        function normalizeNote(note = {}) {
            return {
                id: Number(note.id),
                title: String(note.title || 'Untitled Note'),
                content: String(note.content || ''),
                folder: String(note.folder || 'Notes'),
                tags: Array.isArray(note.tags) ? note.tags : [],
                pinned: Boolean(note.pinned),
                favorite: Boolean(note.favorite),
                updated_at: note.updated_at || new Date().toISOString()
            };
        }

        const api = async (url, options = {}) => {
            const requestOptions = {
                credentials: 'same-origin',
                ...options,
                headers: { ...(options.headers || {}) }
            };
            if (options.body && !requestOptions.headers['Content-Type']) {
                requestOptions.headers['Content-Type'] = 'application/json';
            }

            const response = await fetch(url, requestOptions);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                const error = new Error(data.error || `Request failed (${response.status})`);
                error.status = response.status;
                if (response.status === 401 && url !== '/api/login') {
                    isAuthenticated.value = false;
                }
                throw error;
            }
            return data;
        };

        const cacheNotes = () => {
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify(notes.value));
            } catch {
                showToast('Local cache is full; offline copy was not updated.');
            }
        };

        const saveQueue = (queue) => {
            localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
        };

        const enqueueChange = (change) => {
            let queue = readQueue();
            const id = Number(change.note?.id ?? change.id);

            if (change.type === 'delete') {
                if (id < 0) {
                    queue = queue.filter((item) => Number(item.note?.id ?? item.id) !== id);
                } else {
                    queue = queue.filter(
                        (item) => !(item.type === 'update' && Number(item.note.id) === id)
                    );
                    if (!queue.some((item) => item.type === 'delete' && Number(item.id) === id)) {
                        queue.push({ type: 'delete', id });
                    }
                }
            } else if (id < 0) {
                const existing = queue.find(
                    (item) => item.type === 'create' && Number(item.note.id) === id
                );
                if (existing) existing.note = normalizeNote(change.note);
                else queue.push({ type: 'create', note: normalizeNote(change.note) });
            } else {
                queue = queue.filter(
                    (item) => !(item.type === 'update' && Number(item.note.id) === id)
                );
                queue.push({ type: 'update', note: normalizeNote(change.note) });
            }

            saveQueue(queue);
            saveState.value = 'queued';
        };

        const replaceNote = (updated) => {
            const normalized = normalizeNote(updated);
            const index = notes.value.findIndex((note) => note.id === normalized.id);
            if (index !== -1) {
                notes.value[index] = normalized;
            } else {
                notes.value.unshift(normalized);
            }
            if (currentNote.value?.id === normalized.id) {
                currentNote.value = notes.value.find((note) => note.id === normalized.id);
            }
            cacheNotes();
            return normalized;
        };

        const flushPendingChanges = async () => {
            if (!navigator.onLine || !isAuthenticated.value) return;
            const queue = readQueue();

            while (queue.length) {
                const change = queue[0];
                try {
                    if (change.type === 'create') {
                        const temporaryId = Number(change.note.id);
                        const created = await api('/api/notes', {
                            method: 'POST',
                            body: JSON.stringify(change.note)
                        });
                        const index = notes.value.findIndex((note) => note.id === temporaryId);
                        if (index !== -1) notes.value[index] = normalizeNote(created);
                        if (currentNote.value?.id === temporaryId) {
                            currentNote.value = notes.value[index];
                        }
                    } else if (change.type === 'update') {
                        const updated = await api(`/api/notes/${change.note.id}`, {
                            method: 'PUT',
                            body: JSON.stringify(change.note)
                        });
                        replaceNote(updated);
                    } else if (change.type === 'delete') {
                        await api(`/api/notes/${change.id}`, { method: 'DELETE' });
                    }
                    queue.shift();
                    saveQueue(queue);
                } catch (error) {
                    if (error.status === 404 && change.type === 'delete') {
                        queue.shift();
                        saveQueue(queue);
                        continue;
                    }
                    saveState.value = 'queued';
                    return;
                }
            }

            cacheNotes();
            saveState.value = 'saved';
        };

        const fetchNotes = async () => {
            const fetched = await api('/api/notes');
            notes.value = fetched.map(normalizeNote);
            cacheNotes();
        };

        const login = async () => {
            if (!passwordInput.value) return;
            isLoggingIn.value = true;
            loginError.value = '';
            try {
                await api('/api/login', {
                    method: 'POST',
                    body: JSON.stringify({ password: passwordInput.value })
                });
                passwordInput.value = '';
                isAuthenticated.value = true;
                await flushPendingChanges();
                await fetchNotes();
            } catch (error) {
                loginError.value = error.message;
            } finally {
                isLoggingIn.value = false;
            }
        };

        const logout = async () => {
            try {
                if (navigator.onLine) await api('/api/logout', { method: 'POST' });
            } catch {
                // Locking the local UI should still succeed if the server is unavailable.
            }
            isAuthenticated.value = false;
            currentNote.value = null;
            passwordInput.value = '';
        };

        const continueOffline = () => {
            notes.value = readCachedNotes();
            isAuthenticated.value = true;
            isOffline.value = true;
            showToast('Using the offline copy. Changes will sync after login.');
        };

        const createNewNote = async () => {
            const draft = normalizeNote({
                id: -Date.now(),
                title: 'New Note',
                content: '',
                folder: folderFilter.value || 'Notes'
            });

            if (isOffline.value) {
                notes.value.unshift(draft);
                enqueueChange({ type: 'create', note: draft });
            } else {
                try {
                    const created = await api('/api/notes', {
                        method: 'POST',
                        body: JSON.stringify(draft)
                    });
                    notes.value.unshift(normalizeNote(created));
                } catch {
                    notes.value.unshift(draft);
                    enqueueChange({ type: 'create', note: draft });
                    isOffline.value = true;
                }
            }

            currentNote.value = notes.value[0];
            isEditing.value = true;
            isMobileNoteOpen.value = true;
            cacheNotes();
        };

        const selectNote = (note) => {
            currentNote.value = note;
            isEditing.value = false;
            isMobileNoteOpen.value = true;
            saveState.value = 'saved';
        };

        const closeMobileNote = () => {
            isMobileNoteOpen.value = false;
        };

        const persistNote = async (note) => {
            if (!note) return;
            const snapshot = normalizeNote(note);
            snapshot.updated_at = new Date().toISOString();
            replaceNote(snapshot);

            if (isOffline.value || snapshot.id < 0) {
                enqueueChange({
                    type: snapshot.id < 0 ? 'create' : 'update',
                    note: snapshot
                });
                return;
            }

            saveState.value = 'saving';
            try {
                const updated = await api(`/api/notes/${snapshot.id}`, {
                    method: 'PUT',
                    body: JSON.stringify(snapshot)
                });
                replaceNote(updated);
                saveState.value = 'saved';
            } catch {
                enqueueChange({ type: 'update', note: snapshot });
                isOffline.value = !navigator.onLine;
            }
        };

        const saveNote = () => {
            if (!currentNote.value) return;
            cacheNotes();
            saveState.value = isOffline.value ? 'queued' : 'unsaved';
            clearTimeout(saveTimeout);
            const noteId = currentNote.value.id;
            saveTimeout = setTimeout(() => {
                const note = notes.value.find((item) => item.id === noteId);
                persistNote(note);
            }, 600);
        };

        const saveImmediately = () => {
            if (!currentNote.value) return;
            clearTimeout(saveTimeout);
            persistNote(currentNote.value);
        };

        const updateTags = (value) => {
            if (!currentNote.value) return;
            currentNote.value.tags = [...new Set(
                value.split(',').map((tag) => tag.trim()).filter(Boolean)
            )].slice(0, 20);
            saveNote();
        };

        const toggleNoteFlag = (note, field) => {
            note[field] = !note[field];
            if (currentNote.value?.id === note.id) currentNote.value[field] = note[field];
            clearTimeout(saveTimeout);
            persistNote(note);
        };

        const deleteNote = async (id) => {
            if (!confirm('Are you sure you want to delete this note?')) return;
            clearTimeout(saveTimeout);
            const index = notes.value.findIndex((note) => note.id === id);
            if (index !== -1) notes.value.splice(index, 1);
            currentNote.value = null;
            closeMobileNote();
            cacheNotes();

            if (isOffline.value || id < 0) {
                enqueueChange({ type: 'delete', id });
                return;
            }

            try {
                await api(`/api/notes/${id}`, { method: 'DELETE' });
                showToast('Note deleted.');
            } catch {
                enqueueChange({ type: 'delete', id });
            }
        };

        const showHistory = async () => {
            if (!currentNote.value || currentNote.value.id < 0 || isOffline.value) {
                showToast('Version history is available while online.');
                return;
            }
            historyOpen.value = true;
            historyLoading.value = true;
            historyVersions.value = [];
            try {
                historyVersions.value = await api(
                    `/api/notes/${currentNote.value.id}/history`
                );
            } catch (error) {
                showToast(error.message);
                historyOpen.value = false;
            } finally {
                historyLoading.value = false;
            }
        };

        const restoreVersion = async (versionId) => {
            if (!currentNote.value) return;
            if (!confirm('Restore this version? Your current version will remain in history.')) {
                return;
            }
            try {
                const restored = await api(
                    `/api/notes/${currentNote.value.id}/history/${versionId}/restore`,
                    { method: 'POST' }
                );
                replaceNote(restored);
                historyOpen.value = false;
                showToast('Version restored.');
            } catch (error) {
                showToast(error.message);
            }
        };

        const downloadFile = (filename, content, type) => {
            const blob = new Blob([content], { type });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            link.click();
            URL.revokeObjectURL(url);
        };

        const safeFilename = (value) => String(value || 'note')
            .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
            .slice(0, 100);

        const exportCurrentNote = () => {
            if (!currentNote.value) return;
            downloadFile(
                `${safeFilename(currentNote.value.title)}.md`,
                currentNote.value.content,
                'text/markdown;charset=utf-8'
            );
        };

        const exportAllNotes = () => {
            const backup = {
                exportedAt: new Date().toISOString(),
                version: 2,
                notes: notes.value
            };
            downloadFile(
                `my-notes-backup-${new Date().toISOString().slice(0, 10)}.json`,
                JSON.stringify(backup, null, 2),
                'application/json'
            );
        };

        const openImportPicker = () => importInput.value?.click();

        const importNotes = async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            if (isOffline.value) {
                showToast('Connect and log in before importing a backup.');
                return;
            }

            try {
                const parsed = JSON.parse(await file.text());
                const imported = Array.isArray(parsed) ? parsed : parsed.notes;
                if (!Array.isArray(imported) || !imported.length) {
                    throw new Error('This file does not contain any notes.');
                }
                const result = await api('/api/import', {
                    method: 'POST',
                    body: JSON.stringify({ notes: imported })
                });
                await fetchNotes();
                showToast(`Imported ${result.imported} notes.`);
            } catch (error) {
                showToast(error.message || 'Could not import this file.');
            }
        };

        const getPreviewText = (content) => {
            if (!content) return 'No content';
            const plain = String(content).replace(/[#*`_>[\]()!-]/g, '').replace(/\s+/g, ' ');
            return plain.length > 60 ? `${plain.slice(0, 60)}…` : plain;
        };

        const formatDate = (date) => new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short'
        }).format(new Date(date));

        const formatRelativeDate = (date) => {
            if (!date) return '';
            const difference = Date.now() - new Date(date).getTime();
            if (difference < 60_000) return 'now';
            if (difference < 3_600_000) return `${Math.floor(difference / 60_000)}m`;
            if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)}h`;
            if (difference < 604_800_000) return `${Math.floor(difference / 86_400_000)}d`;
            return new Intl.DateTimeFormat(undefined, {
                month: 'short',
                day: 'numeric'
            }).format(new Date(date));
        };

        function showToast(message) {
            toastMessage.value = message;
            clearTimeout(toastTimeout);
            toastTimeout = setTimeout(() => {
                toastMessage.value = '';
            }, 3000);
        }

        const handleKeyboard = (event) => {
            const modifier = event.metaKey || event.ctrlKey;
            if (modifier && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                searchInput.value?.focus();
            } else if (modifier && event.key.toLowerCase() === 'n') {
                event.preventDefault();
                createNewNote();
            } else if (modifier && event.key.toLowerCase() === 's') {
                event.preventDefault();
                saveImmediately();
            } else if (event.key === 'Escape') {
                if (historyOpen.value) historyOpen.value = false;
                else closeMobileNote();
            }
        };

        const handleOnline = async () => {
            isOffline.value = false;
            if (!isAuthenticated.value) return;
            await flushPendingChanges();
            if (isAuthenticated.value) {
                await fetchNotes().catch(() => {
                    isOffline.value = true;
                });
            }
        };

        const handleOffline = () => {
            isOffline.value = true;
        };

        onMounted(async () => {
            window.addEventListener('keydown', handleKeyboard);
            window.addEventListener('online', handleOnline);
            window.addEventListener('offline', handleOffline);

            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.register('/service-worker.js').catch(() => {
                    // Offline editing still works from local storage if registration fails.
                });
            }

            if (!navigator.onLine) {
                notes.value = readCachedNotes();
                return;
            }

            try {
                const session = await api('/api/session');
                if (session.authenticated) {
                    isAuthenticated.value = true;
                    await flushPendingChanges();
                    await fetchNotes();
                }
            } catch {
                isOffline.value = true;
            }
        });

        onUnmounted(() => {
            window.removeEventListener('keydown', handleKeyboard);
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
            clearTimeout(saveTimeout);
            clearTimeout(toastTimeout);
        });

        return {
            isAuthenticated,
            isLoggingIn,
            passwordInput,
            loginError,
            notes,
            currentNote,
            isEditing,
            isMobileNoteOpen,
            isOffline,
            hasCachedNotes,
            searchQuery,
            folderFilter,
            selectedTag,
            favoritesOnly,
            folders,
            allTags,
            filteredNotes,
            tagText,
            saveState,
            saveStatusText,
            renderedMarkdown,
            historyOpen,
            historyLoading,
            historyVersions,
            toastMessage,
            searchInput,
            importInput,
            login,
            logout,
            continueOffline,
            createNewNote,
            selectNote,
            closeMobileNote,
            saveNote,
            updateTags,
            toggleNoteFlag,
            deleteNote,
            showHistory,
            restoreVersion,
            exportCurrentNote,
            exportAllNotes,
            openImportPicker,
            importNotes,
            getPreviewText,
            formatDate,
            formatRelativeDate
        };
    }
}).mount('#app');
