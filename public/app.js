const { createApp, ref, computed, onMounted } = Vue;

createApp({
    setup() {
        const isAuthenticated = ref(false);
        const passwordInput = ref('');
        const savedPassword = localStorage.getItem('app_password') || '';

        const notes = ref([]);
        const currentNote = ref(null);
        const isEditing = ref(false);
        const isMobileNoteOpen = ref(false);
        let saveTimeout = null;

        const getHeaders = () => ({
            'Content-Type': 'application/json',
            'x-app-password': savedPassword || passwordInput.value
        });

        const login = async () => {
            const res = await fetch('/api/notes', { headers: getHeaders() });
            if (res.status === 200) {
                isAuthenticated.value = true;
                localStorage.setItem('app_password', passwordInput.value || savedPassword);
                notes.value = await res.json();
            } else {
                alert('Incorrect password!');
                passwordInput.value = '';
                localStorage.removeItem('app_password');
            }
        };

        const renderedMarkdown = computed(() => {
            if (!currentNote.value || !currentNote.value.content) {
                return '<em>Start typing...</em>';
            }
            return marked.parse(currentNote.value.content);
        });

        const getPreviewText = (content) => {
            if (!content) return 'No content';
            return content.replace(/[#*`_>]/g, '').substring(0, 40) + '...';
        };

        const createNewNote = async () => {
            const res = await fetch('/api/notes', {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify({ title: 'New Note', content: '' })
            });
            const newNote = await res.json();
            notes.value.unshift(newNote);
            currentNote.value = newNote;
            isEditing.value = true;
            isMobileNoteOpen.value = true;
        };

        const selectNote = (note) => {
            currentNote.value = note;
            isEditing.value = false;
            isMobileNoteOpen.value = true;
        };

        const closeMobileNote = () => {
            isMobileNoteOpen.value = false;
        };

        const saveNote = () => {
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(async () => {
                await fetch(`/api/notes/${currentNote.value.id}`, {
                    method: 'PUT',
                    headers: getHeaders(),
                    body: JSON.stringify(currentNote.value)
                });
                const index = notes.value.findIndex(
                    (note) => note.id === currentNote.value.id
                );
                if (index !== -1) {
                    notes.value[index] = { ...currentNote.value };
                }
            }, 500);
        };

        const deleteNote = async (id) => {
            if (confirm('Are you sure you want to delete this note?')) {
                await fetch(`/api/notes/${id}`, {
                    method: 'DELETE',
                    headers: getHeaders()
                });
                closeMobileNote();
                currentNote.value = null;

                const res = await fetch('/api/notes', { headers: getHeaders() });
                notes.value = await res.json();
            }
        };

        onMounted(() => {
            if (savedPassword) login();
        });

        return {
            isAuthenticated,
            passwordInput,
            login,
            notes,
            currentNote,
            isEditing,
            isMobileNoteOpen,
            closeMobileNote,
            renderedMarkdown,
            createNewNote,
            selectNote,
            saveNote,
            deleteNote,
            getPreviewText
        };
    }
}).mount('#app');
