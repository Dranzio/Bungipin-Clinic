let allThreads = [];
let currentChatUserId = null;
let currentChatUserName = '';

// ─── Constants ──────────────────────────────────────────────────
const MAX_FILE_SIZE = 70 * 1024 * 1024; // 70 MB

// ─── XSS safety ─────────────────────────────────────────────────
// Escapes HTML-significant characters before any DB-sourced string is dropped
// into an innerHTML template. This matters most for msg.content — raw chat
// text a patient or employee types — without this, a malicious message body
// executes as script in whoever opens that conversation next.
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Converts markdown-style [link text](url) into clickable <a> tags.
 * MUST be called AFTER escHtml so the content is already safe.
 * Only allows http:// and https:// URLs to prevent javascript: injection.
 */
function renderLinks(escapedText) {
    return escapedText.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
        (match, text, url) => {
            return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-blue-600 underline hover:text-blue-800 font-semibold">${text}</a>`;
        }
    );
}

// ─── Thread fetching & rendering ────────────────────────────────
async function fetchThreads() {
    const token = localStorage.getItem('userToken');
    if (!token) {
        console.warn("No user token found.");
        return;
    }

    try {
        // Expected to return an array of recent message threads/contacts
        const response = await fetch('/api/messages/threads', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            allThreads = await response.json();
            renderThreads();
        } else {
            console.error("Failed to load message threads.");
        }
    } catch(err) {
        console.error("Network error fetching threads:", err);
    }
}

function renderThreads() {
    const messagesList = document.getElementById('messagesList');
    const searchInput = document.getElementById('searchInput');
    const filterSelect = document.getElementById('filterSelect');

    if(!messagesList) return;

    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
    const filterValue = filterSelect ? filterSelect.value : 'all';

    messagesList.innerHTML = '';

    const filtered = allThreads.filter(thread => {
        const contactName = `${thread.first_name || ''} ${thread.last_name || ''}`.trim().toLowerCase();
        const status = thread.has_unread ? 'unread' : 'read';
        const matchesSearch = contactName.includes(searchTerm);
        const matchesFilter = (filterValue === 'all') || (status === filterValue);
        return matchesSearch && matchesFilter;
    });

    if (filtered.length === 0) {
        messagesList.innerHTML = `<p class="text-center text-gray-500 py-4 font-bold">No messages found.</p>`;
        return;
    }

    filtered.forEach(thread => {
        const statusClass = thread.has_unread ? 'bg-[#009B77]' : 'bg-gray-300';

        const dateObj = new Date(thread.sent_at || Date.now()); // matched to messages.sent_at
        const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const contactId = thread.user_id || thread.contact_id; // matched to users.user_id
        const contactFullName = `${thread.first_name || ''} ${thread.last_name || ''}`.trim() || 'Unknown User';

        const card = document.createElement('div');
        card.className = "message-card relative overflow-hidden w-full h-[100px] bg-white border-1 border-black rounded-[8px] flex items-center justify-between cursor-pointer hover:bg-[#FDFCE9] transition-all";
        card.style.paddingLeft = "3rem";
        card.style.paddingRight = "2rem";
        card.onclick = () => openChat(contactId, contactFullName);

        card.innerHTML = `
            <div class="absolute left-0 top-0 bottom-0 w-3 ${statusClass} border-r-1 border-black"></div>
            <div class="flex items-center gap-4">
                <div class="text-4xl text-[#2c3e2b]">
                    <i class="fa-solid fa-envelope"></i>
                </div>
                <div class="flex flex-col max-w-[200px] sm:max-w-[400px]">
                    <h1 class="font-bold text-2xl text-[#2c3e2b]">${escHtml(contactFullName)}</h1>
                    <p class="text-sm text-gray-600 truncate">${escHtml(thread.content) || 'No messages yet'}</p>
                </div>
            </div>
            <div class="text-sm font-semibold text-gray-600">
                ${timeStr}
            </div>
        `;
        messagesList.appendChild(card);
    });
}

// ─── Chat open / close ──────────────────────────────────────────
async function openChat(contactId, contactName) {
    currentChatUserId = contactId;
    currentChatUserName = contactName;
    document.getElementById("chatDocName").innerText = contactName;
    document.getElementById("chatModal").classList.remove("hidden");

    closeFileErrorBanner();

    // Reset files when opening a new chat
    selectedFiles = [];
    renderFilePreview();

    await loadChatMessages(contactId);
}

function closeChat() {
    document.getElementById("chatModal").classList.add("hidden");
    currentChatUserId = null;
}

// ─── Chat message loading & rendering ───────────────────────────
async function loadChatMessages(contactId) {
    const token = localStorage.getItem('userToken');
    const chatArea = document.getElementById('chatMessagesArea');
    if (!token || !chatArea) return;

    chatArea.innerHTML = '<p class="text-center text-gray-500 py-4 font-bold">Loading messages...</p>';

    try {
        const response = await fetch(`/api/messages/${contactId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            const messages = await response.json();
            renderChatMessages(messages, contactId);
        } else {
            chatArea.innerHTML = '<p class="text-center text-red-500 py-4 font-bold">Failed to load chat history.</p>';
        }
    } catch(err) {
        console.error("Network error fetching chat:", err);
        chatArea.innerHTML = '<p class="text-center text-red-500 py-4 font-bold">Error loading chat.</p>';
    }
}

function renderChatMessages(messages, contactId) {
    const chatArea = document.getElementById('chatMessagesArea');
    if (!chatArea) return;

    chatArea.innerHTML = '';

    if (messages.length === 0) {
        chatArea.innerHTML = '<p class="text-center text-gray-500 py-4 font-bold">No messages yet. Send a message to start the conversation.</p>';
        return;
    }

    messages.forEach(msg => {
        const dateObj = new Date(msg.sent_at);
        const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const isReceived = (msg.sender_id === contactId);

        let attachmentsHtml = '';
        if (msg.file_url) {
            try {
                const urls = JSON.parse(msg.file_url);
                if (Array.isArray(urls) && urls.length > 0) {
                    attachmentsHtml = '<div class="mt-2 flex flex-wrap gap-2">';
                    urls.forEach(url => {
                        const ext = url.split('.').pop().toLowerCase();
                        if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
                            attachmentsHtml += `<a href="${url}" target="_blank"><img src="${url}" class="max-w-[200px] max-h-[200px] object-cover rounded border border-gray-300"></a>`;
                        } else if (['mp4', 'webm', 'ogg'].includes(ext)) {
                            attachmentsHtml += `<video src="${url}" controls class="max-w-[200px] max-h-[200px] rounded border border-gray-300"></video>`;
                        } else {
                            attachmentsHtml += `<a href="${url}" target="_blank" class="flex items-center gap-1 bg-gray-100 text-blue-600 px-3 py-2 rounded border border-gray-300 text-xs font-bold hover:bg-gray-200"><i class="fa-solid fa-file"></i> Download File</a>`;
                        }
                    });
                    attachmentsHtml += '</div>';
                }
            } catch (e) {
                console.error('Error parsing file_url:', e);
            }
        }

        const contentHtml = msg.content ? `<div>${renderLinks(escHtml(msg.content))}</div>` : '';

        if (isReceived) {
            chatArea.innerHTML += `
                <div class="flex flex-col items-start max-w-[80%]">
                    <span class="text-xs text-gray-600 font-semibold mb-1">${escHtml(currentChatUserName)}</span>
                    <div class="bg-white border-2 border-black px-4 py-3 rounded-lg text-sm shadow-sm w-full">
                        ${contentHtml}
                        ${attachmentsHtml}
                    </div>
                    <span class="text-xs text-gray-600 font-semibold mt-1">${timeStr}</span>
                </div>
            `;
        } else {
            chatArea.innerHTML += `
                <div class="flex flex-col items-end self-end max-w-[80%]">
                    <div class="bg-[#D7E3A5] border-2 border-black px-4 py-3 rounded-lg text-sm shadow-sm w-full">
                        ${contentHtml}
                        ${attachmentsHtml}
                    </div>
                    <span class="text-xs text-gray-600 font-semibold mt-1">${timeStr}</span>
                </div>
            `;
        }
    });

    // Scroll chat to the bottom automatically
    chatArea.scrollTop = chatArea.scrollHeight;
}

// ─── File handling ──────────────────────────────────────────────
let selectedFiles = [];

function showFileErrorBanner(message) {
    const banner = document.getElementById('fileErrorBanner');
    const messageEl = document.getElementById('fileErrorMessage');

    if (banner && messageEl) {
        messageEl.innerText = message;
        banner.classList.remove('hidden');
        setTimeout(closeFileErrorBanner, 4500);
    }
}

function closeFileErrorBanner() {
    const banner = document.getElementById('fileErrorBanner');
    if (banner) {
        banner.classList.add('hidden');
    }
}

/**
 * Validates a list of File objects against the 100 MB limit.
 * Returns only the valid files; shows an alert for each rejected file.
 */
function validateFiles(files) {
    const valid = [];
    files.forEach(file => {
        if (file.size > MAX_FILE_SIZE) {
            showFileErrorBanner(`⚠️ "${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB).\n\nMaximum file size allowed is 70 MB. Please choose a smaller file.`);
        } else {
            valid.push(file);
        }
    });
    return valid;
}

function handleFileSelect(event) {
    const files = Array.from(event.target.files);
    const valid = validateFiles(files);
    selectedFiles = selectedFiles.concat(valid);
    renderFilePreview();
    // Reset input so the same file can be selected again if needed
    event.target.value = '';
}

function removeFile(index) {
    selectedFiles.splice(index, 1);
    renderFilePreview();
}

function renderFilePreview() {
    const previewArea = document.getElementById('filePreviewArea');
    if (!previewArea) return;

    if (selectedFiles.length === 0) {
        previewArea.classList.add('hidden');
        previewArea.innerHTML = '';
        return;
    }

    previewArea.classList.remove('hidden');
    previewArea.innerHTML = '';

    selectedFiles.forEach((file, index) => {
        const fileDiv = document.createElement('div');
        fileDiv.className = 'flex items-center gap-2 bg-white border border-gray-300 rounded px-2 py-1 text-xs';

        let icon = '<i class="fa-solid fa-file"></i>';
        if (file.type.startsWith('image/')) icon = '<i class="fa-solid fa-image"></i>';
        else if (file.type.startsWith('video/')) icon = '<i class="fa-solid fa-video"></i>';
        else if (file.type.startsWith('audio/')) icon = '<i class="fa-solid fa-music"></i>';
        else if (file.type === 'application/pdf') icon = '<i class="fa-solid fa-file-pdf"></i>';

        const sizeMB = (file.size / 1024 / 1024).toFixed(1);

        fileDiv.innerHTML = `
            ${icon}
            <span class="max-w-[100px] truncate" title="${escHtml(file.name)}">${escHtml(file.name)}</span>
            <span class="text-gray-400">${sizeMB} MB</span>
            <button onclick="removeFile(${index})" class="text-red-500 hover:text-red-700 ml-1 cursor-pointer"><i class="fa-solid fa-times"></i></button>
        `;
        previewArea.appendChild(fileDiv);
    });
}

// ─── Ctrl + V paste files into chat ─────────────────────────────
function handlePaste(event) {
    const clipboardData = event.clipboardData || event.originalEvent.clipboardData;
    if (!clipboardData) return;

    const files = [];
    for (const item of clipboardData.items) {
        if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) files.push(file);
        }
    }

    if (files.length > 0) {
        const valid = validateFiles(files);
        selectedFiles = selectedFiles.concat(valid);
        renderFilePreview();
        event.preventDefault(); // prevent pasting binary data as text
    }
}

// ─── Drag & drop files into chat ────────────────────────────────
function handleDragOver(event) {
    event.preventDefault();
    event.stopPropagation();
    const dropZone = document.getElementById('chatDropZone');
    if (dropZone) {
        dropZone.classList.add('!border-green-500', '!bg-green-50');
    }
}

function handleDragLeave(event) {
    event.preventDefault();
    event.stopPropagation();
    const dropZone = document.getElementById('chatDropZone');
    if (dropZone) {
        dropZone.classList.remove('!border-green-500', '!bg-green-50');
    }
}

function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();

    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
        const valid = validateFiles(files);
        selectedFiles = selectedFiles.concat(valid);
        renderFilePreview();
    }

    // Remove green highlight
    handleDragLeave(event);
}

// ─── Link modal ─────────────────────────────────────────────────
function openLinkModal() {
    const modal = document.getElementById('linkModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    // Clear previous values and warning
    document.getElementById('linkModalUrl').value = '';
    document.getElementById('linkModalTitle').value = '';
    const warning = document.getElementById('linkModalWarning');
    if (warning) warning.classList.add('hidden');
    document.getElementById('linkModalUrl').focus();
}

function closeLinkModal() {
    const modal = document.getElementById('linkModal');
    if (modal) modal.classList.add('hidden');
    // Hide warning when closing
    const warning = document.getElementById('linkModalWarning');
    if (warning) warning.classList.add('hidden');
}

function insertCustomLink() {
    const url = document.getElementById('linkModalUrl').value.trim();
    const title = document.getElementById('linkModalTitle').value.trim() || url;
    const warning = document.getElementById('linkModalWarning');

    if (!url) {
        // Show inline warning instead of browser alert
        if (warning) warning.classList.remove('hidden');
        return;
    }

    // Hide warning if it was showing
    if (warning) warning.classList.add('hidden');

    const chatInput = document.getElementById('chatInput');
    const linkText = `[${title}](${url})`;

    if (chatInput.value) {
        chatInput.value += ' ' + linkText;
    } else {
        chatInput.value = linkText;
    }

    closeLinkModal();
    chatInput.focus();
}

// ─── Send message ───────────────────────────────────────────────
async function sendMessage() {
    const token = localStorage.getItem('userToken');
    const input = document.getElementById('chatInput');
    const content = input.value.trim();

    if (!token || !currentChatUserId) return;
    if (!content && selectedFiles.length === 0) return;

    try {
        let response;

        // If there are files, use FormData (multipart/form-data)
        if (selectedFiles.length > 0) {
            const formData = new FormData();
            formData.append('receiver_id', currentChatUserId);
            formData.append('content', content);

            selectedFiles.forEach(file => {
                formData.append('attachments', file); // Use 'attachments' or whatever backend expects
            });

            response = await fetch('/api/messages/send', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                    // Do not set Content-Type for FormData, browser will set boundary automatically
                },
                body: formData
            });
        } else {
            // No files, use JSON
            response = await fetch('/api/messages/send', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    receiver_id: currentChatUserId,
                    content: content
                })
            });
        }

        if (response.ok) {
            input.value = '';
            selectedFiles = [];
            renderFilePreview();

            // Reload the specific chat to show the new message
            await loadChatMessages(currentChatUserId);
            // Refresh the threads in the background to update the snippet and timestamp
            fetchThreads();
        } else {
            alert('Failed to send message.');
        }
    } catch(err) {
        console.error("Network error sending message:", err);
        alert('Error sending message. Please check your connection.');
    }
}

// ─── DOMContentLoaded — wire up all event listeners ─────────────
document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('searchInput');
    const filterSelect = document.getElementById('filterSelect');

    if (searchInput) {
        searchInput.addEventListener('input', renderThreads);
    }

    if (filterSelect) {
        filterSelect.addEventListener('change', renderThreads);
    }

    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        // Enter to send
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Ctrl+V paste files
        chatInput.addEventListener('paste', handlePaste);
    }

    // Drag & drop on the chat input area (uses a wrapper div "chatDropZone")
    const dropZone = document.getElementById('chatDropZone');
    if (dropZone) {
        dropZone.addEventListener('dragover', handleDragOver);
        dropZone.addEventListener('dragleave', handleDragLeave);
        dropZone.addEventListener('drop', handleDrop);
    }

    // Automatically load messages when the page opens
    fetchThreads();
});