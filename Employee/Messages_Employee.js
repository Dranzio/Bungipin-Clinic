let allThreads = [];
let currentChatUserId = null;
let currentChatUserName = '';

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
                    <h1 class="font-bold text-2xl text-[#2c3e2b]">${contactFullName}</h1>
                    <p class="text-sm text-gray-600 truncate">${thread.content || 'No messages yet'}</p>
                </div>
            </div>
            <div class="text-sm font-semibold text-gray-600">
                ${timeStr}
            </div>
        `;
        messagesList.appendChild(card);
    });
}

async function openChat(contactId, contactName) {
    currentChatUserId = contactId;
    currentChatUserName = contactName;
    document.getElementById("chatDocName").innerText = contactName;
    document.getElementById("chatModal").classList.remove("hidden");

    await loadChatMessages(contactId);
}

function closeChat() {
    document.getElementById("chatModal").classList.add("hidden");
    currentChatUserId = null;
}

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

        // If the sender is the contact, it's a received message
        const isReceived = (msg.sender_id === contactId);

        if (isReceived) {
            chatArea.innerHTML += `
                <div class="flex flex-col items-start max-w-[80%]">
                    <span class="text-xs text-gray-600 font-semibold mb-1">${currentChatUserName}</span>
                    <div class="bg-white border-2 border-black px-4 py-3 rounded-lg text-sm shadow-sm w-full">
                        ${msg.content}
                    </div>
                    <span class="text-xs text-gray-600 font-semibold mt-1">${timeStr}</span>
                </div>
            `;
        } else {
            // Otherwise, it was sent by the current user
            chatArea.innerHTML += `
                <div class="flex flex-col items-end self-end max-w-[80%]">
                    <div class="bg-[#D7E3A5] border-2 border-black px-4 py-3 rounded-lg text-sm shadow-sm w-full">
                        ${msg.content}
                    </div>
                    <span class="text-xs text-gray-600 font-semibold mt-1">${timeStr}</span>
                </div>
            `;
        }
    });

    // Scroll chat to the bottom automatically
    chatArea.scrollTop = chatArea.scrollHeight;
}

async function sendMessage() {
    const token = localStorage.getItem('userToken');
    const input = document.getElementById('chatInput');
    const content = input.value.trim();

    if (!token || !content || !currentChatUserId) return;

    try {
        const response = await fetch('/api/messages/send', {
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

        if (response.ok) {
            input.value = '';
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

document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('searchInput');
    const filterSelect = document.getElementById('filterSelect');

    if (searchInput) {
        searchInput.addEventListener('input', renderThreads);
    }

    if (filterSelect) {
        filterSelect.addEventListener('change', renderThreads);
    }

    // Automatically load messages when the page opens
    fetchThreads();
});