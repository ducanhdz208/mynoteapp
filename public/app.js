const { createApp, ref, computed, nextTick, onMounted, onUnmounted } = Vue;

const CACHE_KEY = 'personal_notes_cache_v3';
const LEGACY_CACHE_KEY = 'personal_notes_cache_v2';
const QUEUE_KEY = 'personal_notes_sync_queue_v3';
const LEGACY_QUEUE_KEY = 'personal_notes_sync_queue_v2';

createApp({
    setup() {
        const isAuthenticated = ref(false);
        const isLoggingIn = ref(false);
        const passwordInput = ref('');
        const loginError = ref('');
        const notes = ref([]);
        const currentNote = ref(null);
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
        const editor = ref(null);
        const draggedNoteId = ref(null);
        const dropTargetId = ref(null);
        const dropPosition = ref('before');
        const activeFormats = ref({
            bold: false,
            italic: false,
            underline: false,
            strikeThrough: false,
            insertUnorderedList: false,
            insertOrderedList: false
        });
        const selectedBlock = ref('p');
        const selectedFont = ref('');
        const selectedFontSize = ref('');

        let saveTimeout = null;
        let toastTimeout = null;
        let savedSelection = null;
        let suppressNextNoteClick = false;
        let touchReorderState = null;

        function sanitizeRichText(html) {
            return DOMPurify.sanitize(String(html || ''), {
                USE_PROFILES: { html: true },
                FORBID_TAGS: [
                    'script', 'style', 'iframe', 'object', 'embed', 'form',
                    'input', 'button', 'textarea', 'select', 'option'
                ]
            });
        }

        function markdownToRichText(markdown) {
            if (!markdown) return '';
            const html = marked.parse(String(markdown), {
                breaks: true,
                gfm: true
            });
            return sanitizeRichText(html);
        }

        function richTextToMarkdown(html) {
            const root = document.createElement('div');
            root.innerHTML = sanitizeRichText(html);

            const renderChildren = (node) => [...node.childNodes]
                .map((child) => renderNode(child))
                .join('');

            const renderList = (node, ordered) => {
                const items = [...node.children].filter(
                    (child) => child.tagName.toLowerCase() === 'li'
                );
                return items.map((item, index) => {
                    const marker = ordered ? `${index + 1}. ` : '- ';
                    const content = renderChildren(item)
                        .trim()
                        .replace(/\n{3,}/g, '\n\n')
                        .replace(/\n/g, '\n  ');
                    return `${marker}${content}`;
                }).join('\n') + '\n\n';
            };

            const escapeText = (value) => String(value)
                .replace(/\\/g, '\\\\')
                .replace(/([`*_[\]])/g, '\\$1');

            const renderNode = (node) => {
                if (node.nodeType === Node.TEXT_NODE) {
                    return escapeText(node.nodeValue || '');
                }
                if (node.nodeType !== Node.ELEMENT_NODE) return '';

                const tag = node.tagName.toLowerCase();
                const children = renderChildren(node);
                const trimmed = children.trim();

                if (tag === 'br') return '\n';
                if (tag === 'p' || tag === 'div') return `${trimmed}\n\n`;
                if (/^h[1-6]$/.test(tag)) {
                    return `${'#'.repeat(Number(tag.slice(1)))} ${trimmed}\n\n`;
                }
                if (tag === 'strong' || tag === 'b') return `**${children}**`;
                if (tag === 'em' || tag === 'i') return `*${children}*`;
                if (tag === 's' || tag === 'strike' || tag === 'del') {
                    return `~~${children}~~`;
                }
                if (tag === 'u') return `<u>${children}</u>`;
                if (tag === 'blockquote') {
                    return `${trimmed.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
                }
                if (tag === 'ul') return renderList(node, false);
                if (tag === 'ol') return renderList(node, true);
                if (tag === 'li') return children;
                if (tag === 'a') {
                    const href = node.getAttribute('href') || '';
                    return href ? `[${children || href}](${href})` : children;
                }
                if (tag === 'img') {
                    const source = node.getAttribute('src') || '';
                    const alt = node.getAttribute('alt') || '';
                    return source ? `![${alt}](${source})` : '';
                }
                if (tag === 'pre') {
                    return `\`\`\`\n${node.textContent.replace(/\n$/, '')}\n\`\`\`\n\n`;
                }
                if (tag === 'code') return `\`${node.textContent}\``;
                if (tag === 'hr') return '---\n\n';
                return children;
            };

            return renderChildren(root)
                .replace(/[ \t]+\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        }

        function contentToPlainText(content, contentFormat = 'markdown') {
            if (!content) return '';
            const holder = document.createElement('div');
            holder.innerHTML = contentFormat === 'html'
                ? sanitizeRichText(content)
                : markdownToRichText(content);
            return (holder.textContent || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        }

        function normalizeNote(note = {}) {
            const contentFormat = note.content_format === 'html' ? 'html' : 'markdown';
            const numericOrder = Number(note.sort_order);
            return {
                id: Number(note.id),
                title: String(note.title || 'Untitled Note'),
                content: contentFormat === 'html'
                    ? sanitizeRichText(note.content)
                    : String(note.content || ''),
                content_format: contentFormat,
                folder: String(note.folder || 'Notes'),
                tags: Array.isArray(note.tags) ? note.tags : [],
                pinned: Boolean(note.pinned),
                favorite: Boolean(note.favorite),
                sort_order: Number.isFinite(numericOrder) ? numericOrder : 0,
                updated_at: note.updated_at || new Date().toISOString()
            };
        }

        const compareNotes = (left, right) => {
            if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
            const orderDifference = Number(left.sort_order) - Number(right.sort_order);
            if (orderDifference) return orderDifference;
            const dateDifference = new Date(right.updated_at || 0)
                - new Date(left.updated_at || 0);
            if (dateDifference) return dateDifference;
            return Number(right.id) - Number(left.id);
        };

        const getOrderedNotes = () => notes.value.slice().sort(compareNotes);

        const noteFingerprint = (note) => JSON.stringify({
            title: note?.title,
            content: note?.content,
            content_format: note?.content_format,
            folder: note?.folder,
            tags: note?.tags || [],
            pinned: Boolean(note?.pinned),
            favorite: Boolean(note?.favorite),
            sort_order: Number(note?.sort_order)
        });

        const readCachedNotes = () => {
            try {
                const stored = localStorage.getItem(CACHE_KEY)
                    || localStorage.getItem(LEGACY_CACHE_KEY)
                    || '[]';
                const cached = JSON.parse(stored);
                return Array.isArray(cached) ? cached.map(normalizeNote) : [];
            } catch {
                return [];
            }
        };

        const readQueue = () => {
            try {
                const stored = localStorage.getItem(QUEUE_KEY)
                    || localStorage.getItem(LEGACY_QUEUE_KEY)
                    || '[]';
                const queue = JSON.parse(stored);
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
                        contentToPlainText(note.content, note.content_format),
                        note.folder,
                        ...(note.tags || [])
                    ].join(' ').toLowerCase();
                    return (!query || searchable.includes(query))
                        && (!folderFilter.value || note.folder === folderFilter.value)
                        && (!selectedTag.value || note.tags.includes(selectedTag.value))
                        && (!favoritesOnly.value || note.favorite);
                })
                .slice()
                .sort(compareNotes);
        });

        const tagText = computed(() => (currentNote.value?.tags || []).join(', '));

        const saveStatusText = computed(() => ({
            unsaved: 'Unsaved changes',
            saving: 'Saving…',
            saved: 'Saved',
            queued: 'Queued offline',
            error: 'Save failed'
        })[saveState.value] || 'Saved');

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
                localStorage.removeItem(LEGACY_CACHE_KEY);
            } catch {
                showToast('Local cache is full; offline copy was not updated.');
            }
        };

        const saveQueue = (queue) => {
            localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
            localStorage.removeItem(LEGACY_QUEUE_KEY);
        };

        const enqueueChange = (change) => {
            let queue = readQueue();

            if (change.type === 'reorder') {
                queue = queue.filter((item) => item.type !== 'reorder');
                queue.push({
                    type: 'reorder',
                    orderedIds: change.orderedIds.map(Number)
                });
                saveQueue(queue);
                saveState.value = 'queued';
                return;
            }

            const id = Number(change.note?.id ?? change.id);
            if (change.type === 'delete') {
                if (id < 0) {
                    queue = queue.filter((item) => Number(item.note?.id ?? item.id) !== id);
                    queue.forEach((item) => {
                        if (item.type === 'reorder') {
                            item.orderedIds = item.orderedIds.filter(
                                (noteId) => Number(noteId) !== id
                            );
                        }
                    });
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
                        const normalized = normalizeNote(created);
                        const index = notes.value.findIndex((note) => note.id === temporaryId);
                        if (index !== -1) notes.value[index] = normalized;
                        if (currentNote.value?.id === temporaryId) {
                            currentNote.value = index === -1 ? normalized : notes.value[index];
                        }
                        queue.forEach((queuedItem) => {
                            if (queuedItem.type === 'reorder') {
                                queuedItem.orderedIds = queuedItem.orderedIds.map(
                                    (id) => Number(id) === temporaryId ? normalized.id : Number(id)
                                );
                            }
                        });
                    } else if (change.type === 'update') {
                        const updated = await api(`/api/notes/${change.note.id}`, {
                            method: 'PUT',
                            body: JSON.stringify(change.note)
                        });
                        replaceNote(updated);
                    } else if (change.type === 'delete') {
                        await api(`/api/notes/${change.id}`, { method: 'DELETE' });
                    } else if (change.type === 'reorder') {
                        const orderedIds = change.orderedIds
                            .map(Number)
                            .filter((id) => id > 0);
                        if (orderedIds.length) {
                            await api('/api/notes/reorder', {
                                method: 'POST',
                                body: JSON.stringify({ orderedIds })
                            });
                        }
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
            const selectedId = currentNote.value?.id;
            const fetched = await api('/api/notes');
            notes.value = fetched.map(normalizeNote);
            if (selectedId != null) {
                currentNote.value = notes.value.find((note) => note.id === selectedId) || null;
            }
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
            await flushPendingNoteSave();
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

        const prepareNoteForEditing = (note) => {
            if (!note) return false;
            if (note.content_format !== 'html') {
                note.content = markdownToRichText(note.content);
                note.content_format = 'html';
                cacheNotes();
                return true;
            }
            const sanitized = sanitizeRichText(note.content);
            const changed = sanitized !== note.content;
            note.content = sanitized;
            return changed;
        };

        const syncEditorContent = ({ focus = false } = {}) => nextTick(() => {
            if (!editor.value) return;
            const html = currentNote.value?.content_format === 'html'
                ? currentNote.value.content
                : markdownToRichText(currentNote.value?.content || '');
            editor.value.innerHTML = sanitizeRichText(html);
            if (focus) editor.value.focus();
            rememberSelection();
        });

        function flushPendingNoteSave() {
            if (!saveTimeout || !currentNote.value) return Promise.resolve();
            clearTimeout(saveTimeout);
            saveTimeout = null;
            return persistNote(currentNote.value);
        }

        const createNewNote = async () => {
            flushPendingNoteSave();
            const unpinnedOrders = notes.value
                .filter((note) => !note.pinned)
                .map((note) => Number(note.sort_order));
            const topOrder = unpinnedOrders.length ? Math.min(...unpinnedOrders) - 1 : 0;
            const draft = normalizeNote({
                id: -Date.now(),
                title: 'New Note',
                content: '',
                content_format: 'html',
                folder: folderFilter.value || 'Notes',
                sort_order: topOrder
            });

            let selectedNote = draft;
            if (isOffline.value) {
                notes.value.unshift(draft);
                enqueueChange({ type: 'create', note: draft });
            } else {
                try {
                    const created = normalizeNote(await api('/api/notes', {
                        method: 'POST',
                        body: JSON.stringify(draft)
                    }));
                    notes.value.unshift(created);
                    selectedNote = created;
                } catch {
                    notes.value.unshift(draft);
                    enqueueChange({ type: 'create', note: draft });
                    isOffline.value = true;
                }
            }

            currentNote.value = selectedNote;
            isMobileNoteOpen.value = true;
            cacheNotes();
            syncEditorContent({ focus: true });
        };

        const selectNote = (note) => {
            if (suppressNextNoteClick) return;
            if (currentNote.value?.id !== note.id) flushPendingNoteSave();
            currentNote.value = note;
            isMobileNoteOpen.value = true;
            saveState.value = 'saved';
            const converted = prepareNoteForEditing(note);
            syncEditorContent();
            if (converted) saveNote();
        };

        const closeMobileNote = () => {
            isMobileNoteOpen.value = false;
        };

        const persistNote = async (note) => {
            if (!note) return;
            const snapshot = normalizeNote(note);
            const snapshotFingerprint = noteFingerprint(snapshot);
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
                const updated = normalizeNote(await api(`/api/notes/${snapshot.id}`, {
                    method: 'PUT',
                    body: JSON.stringify(snapshot)
                }));
                const liveNote = notes.value.find((item) => item.id === snapshot.id);
                if (liveNote && noteFingerprint(liveNote) === snapshotFingerprint) {
                    replaceNote(updated);
                    saveState.value = 'saved';
                }
            } catch {
                enqueueChange({ type: 'update', note: snapshot });
                isOffline.value = !navigator.onLine;
            }
        };

        function saveNote() {
            if (!currentNote.value) return;
            cacheNotes();
            saveState.value = isOffline.value ? 'queued' : 'unsaved';
            clearTimeout(saveTimeout);
            const noteId = currentNote.value.id;
            saveTimeout = setTimeout(() => {
                saveTimeout = null;
                const note = notes.value.find((item) => item.id === noteId);
                persistNote(note);
            }, 600);
        }

        const saveImmediately = () => {
            if (!currentNote.value) return;
            clearTimeout(saveTimeout);
            saveTimeout = null;
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
            if (field === 'pinned') {
                const destinationOrders = notes.value
                    .filter((item) => item.id !== note.id && item.pinned === note.pinned)
                    .map((item) => Number(item.sort_order));
                note.sort_order = destinationOrders.length
                    ? Math.min(...destinationOrders) - 1
                    : 0;
            }
            if (currentNote.value?.id === note.id) {
                currentNote.value[field] = note[field];
                currentNote.value.sort_order = note.sort_order;
            }
            if (currentNote.value?.id !== note.id) {
                flushPendingNoteSave();
            } else {
                clearTimeout(saveTimeout);
                saveTimeout = null;
            }
            persistNote(note);
        };

        const persistNoteOrder = async () => {
            const orderedIds = getOrderedNotes().map((note) => note.id);
            cacheNotes();
            if (isOffline.value || orderedIds.some((id) => id < 0)) {
                enqueueChange({ type: 'reorder', orderedIds });
                return;
            }

            saveState.value = 'saving';
            try {
                await api('/api/notes/reorder', {
                    method: 'POST',
                    body: JSON.stringify({ orderedIds })
                });
                saveState.value = 'saved';
            } catch {
                enqueueChange({ type: 'reorder', orderedIds });
                isOffline.value = !navigator.onLine;
            }
        };

        const applyVisibleReorder = (sourceId, targetId, position = 'before') => {
            const source = notes.value.find((note) => note.id === Number(sourceId));
            const target = notes.value.find((note) => note.id === Number(targetId));
            if (!source || !target || source.id === target.id) return false;
            if (source.pinned !== target.pinned) {
                showToast('Pinned notes stay in their own top group.');
                return false;
            }

            const group = getOrderedNotes().filter(
                (note) => note.pinned === source.pinned
            );
            const visibleGroup = filteredNotes.value.filter(
                (note) => note.pinned === source.pinned
            );
            const reorderedVisible = visibleGroup.filter((note) => note.id !== source.id);
            const targetIndex = reorderedVisible.findIndex((note) => note.id === target.id);
            if (targetIndex === -1) return false;
            reorderedVisible.splice(
                targetIndex + (position === 'after' ? 1 : 0),
                0,
                source
            );

            const visibleIds = new Set(visibleGroup.map((note) => note.id));
            let visibleIndex = 0;
            const reorderedGroup = group.map((note) => {
                if (!visibleIds.has(note.id)) return note;
                const replacement = reorderedVisible[visibleIndex];
                visibleIndex += 1;
                return replacement;
            });
            reorderedGroup.forEach((note, index) => {
                note.sort_order = index;
            });
            cacheNotes();
            return true;
        };

        const beginDrag = (note, event) => {
            if (event.target.closest('.note-card-actions')) {
                event.preventDefault();
                return;
            }
            draggedNoteId.value = note.id;
            dropTargetId.value = null;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', String(note.id));
            requestAnimationFrame(() => {
                event.currentTarget.classList.add('dragging');
            });
        };

        const dragOverNote = (note, event) => {
            const source = notes.value.find(
                (item) => item.id === Number(draggedNoteId.value)
            );
            if (!source || source.id === note.id || source.pinned !== note.pinned) {
                dropTargetId.value = null;
                return;
            }
            const bounds = event.currentTarget.getBoundingClientRect();
            dropTargetId.value = note.id;
            dropPosition.value = event.clientY < bounds.top + bounds.height / 2
                ? 'before'
                : 'after';
            event.dataTransfer.dropEffect = 'move';
        };

        const dropNote = async (note) => {
            const changed = applyVisibleReorder(
                draggedNoteId.value,
                note.id,
                dropPosition.value
            );
            endDrag();
            if (changed) await persistNoteOrder();
        };

        const endDrag = () => {
            document.querySelectorAll('.course-item.dragging').forEach(
                (element) => element.classList.remove('dragging')
            );
            draggedNoteId.value = null;
            dropTargetId.value = null;
            suppressNextNoteClick = true;
            setTimeout(() => {
                suppressNextNoteClick = false;
            }, 120);
        };

        const handleTouchReorderMove = (event) => {
            if (!touchReorderState || event.pointerId !== touchReorderState.pointerId) return;
            event.preventDefault();
            const targetElement = document
                .elementFromPoint(event.clientX, event.clientY)
                ?.closest('.course-item');
            if (!targetElement) return;
            const targetId = Number(targetElement.dataset.noteId);
            if (!Number.isFinite(targetId) || targetId === touchReorderState.sourceId) return;
            const bounds = targetElement.getBoundingClientRect();
            const position = event.clientY < bounds.top + bounds.height / 2
                ? 'before'
                : 'after';
            if (applyVisibleReorder(touchReorderState.sourceId, targetId, position)) {
                touchReorderState.changed = true;
                dropTargetId.value = targetId;
                dropPosition.value = position;
            }
        };

        const finishTouchReorder = async (event) => {
            if (!touchReorderState || event.pointerId !== touchReorderState.pointerId) return;
            const changed = touchReorderState.changed;
            touchReorderState = null;
            window.removeEventListener('pointermove', handleTouchReorderMove);
            window.removeEventListener('pointerup', finishTouchReorder);
            window.removeEventListener('pointercancel', finishTouchReorder);
            draggedNoteId.value = null;
            dropTargetId.value = null;
            suppressNextNoteClick = true;
            setTimeout(() => {
                suppressNextNoteClick = false;
            }, 180);
            if (changed) await persistNoteOrder();
        };

        const beginTouchReorder = (note, event) => {
            if (event.pointerType === 'mouse') return;
            event.preventDefault();
            touchReorderState = {
                pointerId: event.pointerId,
                sourceId: note.id,
                changed: false
            };
            draggedNoteId.value = note.id;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            window.addEventListener('pointermove', handleTouchReorderMove, { passive: false });
            window.addEventListener('pointerup', finishTouchReorder);
            window.addEventListener('pointercancel', finishTouchReorder);
        };

        const reorderWithKeyboard = async (note, direction, event) => {
            event.preventDefault();
            event.stopPropagation();
            const visibleGroup = filteredNotes.value.filter(
                (item) => item.pinned === note.pinned
            );
            const index = visibleGroup.findIndex((item) => item.id === note.id);
            const targetIndex = index + direction;
            if (index === -1 || targetIndex < 0 || targetIndex >= visibleGroup.length) return;
            const target = visibleGroup[targetIndex];
            const changed = applyVisibleReorder(
                note.id,
                target.id,
                direction < 0 ? 'before' : 'after'
            );
            if (!changed) return;
            await persistNoteOrder();
            nextTick(() => {
                document.querySelector(
                    `.course-item[data-note-id="${note.id}"] .drag-handle`
                )?.focus();
            });
        };

        const deleteNote = async (id) => {
            if (!confirm('Are you sure you want to delete this note?')) return;
            clearTimeout(saveTimeout);
            saveTimeout = null;
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
            await flushPendingNoteSave();
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
                const restored = replaceNote(await api(
                    `/api/notes/${currentNote.value.id}/history/${versionId}/restore`,
                    { method: 'POST' }
                ));
                currentNote.value = restored;
                const converted = prepareNoteForEditing(restored);
                syncEditorContent();
                if (converted) saveNote();
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
            const markdown = currentNote.value.content_format === 'html'
                ? richTextToMarkdown(currentNote.value.content)
                : currentNote.value.content;
            downloadFile(
                `${safeFilename(currentNote.value.title)}.md`,
                markdown,
                'text/markdown;charset=utf-8'
            );
        };

        const exportAllNotes = () => {
            const backup = {
                exportedAt: new Date().toISOString(),
                version: 3,
                notes: getOrderedNotes()
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

        const getPreviewText = (content, contentFormat = 'markdown') => {
            const plain = contentToPlainText(content, contentFormat);
            if (!plain) return 'No content';
            return plain.length > 60 ? `${plain.slice(0, 60)}…` : plain;
        };

        const isEditorVisuallyEmpty = (html) => {
            const holder = document.createElement('div');
            holder.innerHTML = html;
            return !holder.textContent.trim() && !holder.querySelector('img, hr, table');
        };

        const handleEditorInput = () => {
            if (!currentNote.value || !editor.value) return;
            const sanitized = sanitizeRichText(editor.value.innerHTML);
            currentNote.value.content = isEditorVisuallyEmpty(sanitized) ? '' : sanitized;
            currentNote.value.content_format = 'html';
            rememberSelection();
            saveNote();
        };

        const looksLikeMarkdown = (text) => {
            if (!text) return false;
            return /(^|\n)\s{0,3}(#{1,6}\s|>\s|[-+*]\s|\d+\.\s|```|~~~|---+\s*$)/m
                .test(text)
                || /(\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`)/.test(text)
                || /(^|[\s(])([*_])[^*_\n]+\2(?=$|[\s).,!?:;])/.test(text)
                || /\[[^\]\n]+\]\([^) \n]+(?:\s+"[^"]*")?\)/.test(text);
        };

        const insertEditorContent = (command, value) => {
            restoreSelection();
            editor.value?.focus();
            document.execCommand(command, false, value);
            handleEditorInput();
        };

        const handleEditorPaste = (event) => {
            const plainText = event.clipboardData?.getData('text/plain') || '';
            const sourceHtml = event.clipboardData?.getData('text/html') || '';
            event.preventDefault();

            if (looksLikeMarkdown(plainText)) {
                insertEditorContent('insertHTML', markdownToRichText(plainText));
                showToast('Markdown formatted automatically.');
            } else if (sourceHtml) {
                insertEditorContent('insertHTML', sanitizeRichText(sourceHtml));
            } else {
                insertEditorContent('insertText', plainText);
            }
        };

        const handleEditorDrop = (event) => {
            if (!event.dataTransfer?.files?.length) return;
            event.preventDefault();
            showToast('Image and file uploads are not supported yet.');
        };

        const selectionIsInEditor = (selection) => {
            if (!editor.value || !selection?.rangeCount) return false;
            const range = selection.getRangeAt(0);
            return editor.value.contains(range.commonAncestorContainer);
        };

        function updateToolbarState() {
            const selection = window.getSelection();
            if (!selectionIsInEditor(selection)) return;
            Object.keys(activeFormats.value).forEach((command) => {
                activeFormats.value[command] = document.queryCommandState(command);
            });
            const block = String(document.queryCommandValue('formatBlock') || '')
                .replace(/[<>]/g, '')
                .toLowerCase();
            selectedBlock.value = ['h1', 'h2', 'h3', 'blockquote'].includes(block)
                ? block
                : 'p';
            const font = String(document.queryCommandValue('fontName') || '')
                .replace(/['"]/g, '');
            selectedFont.value = ['Arial', 'Georgia', 'Trebuchet MS', 'Courier New']
                .find((option) => font.toLowerCase().includes(option.toLowerCase()))
                || '';
            const fontSize = String(document.queryCommandValue('fontSize') || '');
            selectedFontSize.value = ['2', '3', '4', '5', '6'].includes(fontSize)
                ? fontSize
                : '';
        }

        function rememberSelection() {
            const selection = window.getSelection();
            if (!selectionIsInEditor(selection)) return;
            savedSelection = selection.getRangeAt(0).cloneRange();
            updateToolbarState();
        }

        function restoreSelection() {
            if (!savedSelection) return;
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(savedSelection);
        }

        const runEditorCommand = (command, value = null) => {
            if (!editor.value) return;
            restoreSelection();
            editor.value.focus();
            document.execCommand(command, false, value);
            rememberSelection();
            handleEditorInput();
        };

        const applyBlock = () => {
            runEditorCommand('formatBlock', selectedBlock.value);
        };

        const applyFont = () => {
            if (selectedFont.value) {
                runEditorCommand('fontName', selectedFont.value);
            }
        };

        const applyFontSize = () => {
            if (selectedFontSize.value) {
                runEditorCommand('fontSize', selectedFontSize.value);
            }
        };

        const addLink = () => {
            const input = prompt('Paste or type the link URL:');
            if (!input) return;
            const url = /^[a-z][a-z\d+.-]*:|^#|^\//i.test(input)
                ? input
                : `https://${input}`;
            runEditorCommand('createLink', url);
        };

        const clearFormatting = () => {
            runEditorCommand('removeFormat');
            runEditorCommand('unlink');
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
            document.addEventListener('selectionchange', rememberSelection);

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
            window.removeEventListener('pointermove', handleTouchReorderMove);
            window.removeEventListener('pointerup', finishTouchReorder);
            window.removeEventListener('pointercancel', finishTouchReorder);
            document.removeEventListener('selectionchange', rememberSelection);
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
            historyOpen,
            historyLoading,
            historyVersions,
            toastMessage,
            searchInput,
            importInput,
            editor,
            draggedNoteId,
            dropTargetId,
            dropPosition,
            activeFormats,
            selectedBlock,
            selectedFont,
            selectedFontSize,
            login,
            logout,
            continueOffline,
            createNewNote,
            selectNote,
            closeMobileNote,
            saveNote,
            updateTags,
            toggleNoteFlag,
            beginDrag,
            dragOverNote,
            dropNote,
            endDrag,
            beginTouchReorder,
            reorderWithKeyboard,
            deleteNote,
            showHistory,
            restoreVersion,
            exportCurrentNote,
            exportAllNotes,
            openImportPicker,
            importNotes,
            getPreviewText,
            handleEditorInput,
            handleEditorPaste,
            handleEditorDrop,
            rememberSelection,
            runEditorCommand,
            applyBlock,
            applyFont,
            applyFontSize,
            addLink,
            clearFormatting,
            formatDate,
            formatRelativeDate
        };
    }
}).mount('#app');
