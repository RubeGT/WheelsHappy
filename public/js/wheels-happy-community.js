(function () {
    'use strict';

    const API = window.WHEELS_HAPPY_API_BASE;
    const TOKEN_KEY = 'wheels-happy-token';
    const USER_KEY = 'wheels-happy-user';
    const create = (tag, text, className) => {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    };

    const style = create('style');
    style.textContent = `
      #wh-community { position:fixed; z-index:100000; top:12px; right:14px; display:flex; gap:8px; font:14px Arial,sans-serif; }
      #wh-community button { border:1px solid #d7c466; border-radius:4px; background:#202020; color:#fff; padding:9px 12px; font:inherit; cursor:pointer; }
      #wh-community button:hover { background:#393428; }
      #wh-community .wh-modal { position:fixed; inset:0; display:grid; place-items:center; padding:18px; background:#000b; }
      #wh-community .wh-modal[hidden], #wh-community [hidden] { display:none !important; }
      #wh-community .wh-card { box-sizing:border-box; width:min(560px,100%); max-height:90vh; overflow:auto; padding:22px; border:1px solid #d7c466; border-radius:8px; background:#171717; color:#f7f2df; box-shadow:0 12px 50px #000a; }
      #wh-community h2 { margin:0 0 14px; color:#f1db63; font-size:22px; }
      #wh-community p { line-height:1.45; }
      #wh-community label { display:block; margin:12px 0 5px; color:#e7dfc4; }
      #wh-community input, #wh-community textarea { box-sizing:border-box; width:100%; border:1px solid #777; border-radius:4px; background:#090909; color:white; padding:10px; font:14px Arial,sans-serif; }
      #wh-community textarea { min-height:90px; resize:vertical; }
      #wh-community .wh-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:14px; }
      #wh-community .wh-message { min-height:1.4em; color:#f1db63; }
      #wh-community .wh-level { padding:12px 0; border-top:1px solid #444; }
      #wh-community .wh-level strong { display:block; margin-bottom:4px; }
      #wh-community .wh-muted { color:#aaa; font-size:12px; }
      #wh-community .wh-close { float:right; }
    `;

    const root = create('div');
    root.id = 'wh-community';
    const accountButton = create('button', 'Sign in');
    const levelsButton = create('button', 'Browse Levels');
    const modal = create('div', undefined, 'wh-modal');
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const card = create('section', undefined, 'wh-card');
    const closeButton = create('button', 'Close', 'wh-close');
    const title = create('h2', 'Wheels Happy account');
    const message = create('p', '', 'wh-message');
    const form = create('form');
    const displayNameLabel = create('label', 'Display name');
    const displayName = create('input');
    displayName.name = 'display_name';
    displayName.autocomplete = 'nickname';
    displayName.minLength = 2;
    displayName.maxLength = 32;
    displayNameLabel.append(displayName);
    const emailLabel = create('label', 'Email');
    const email = create('input');
    email.name = 'email';
    email.type = 'email';
    email.required = true;
    email.autocomplete = 'email';
    emailLabel.append(email);
    const passwordLabel = create('label', 'Password');
    const password = create('input');
    password.name = 'password';
    password.type = 'password';
    password.required = true;
    password.minLength = 10;
    password.maxLength = 128;
    password.autocomplete = 'current-password';
    passwordLabel.append(password);
    const buttons = create('div', undefined, 'wh-row');
    const submit = create('button', 'Sign in');
    submit.type = 'submit';
    const switchMode = create('button', 'Create account');
    switchMode.type = 'button';
    const signOut = create('button', 'Sign out');
    signOut.type = 'button';
    signOut.hidden = true;
    form.append(displayNameLabel, emailLabel, passwordLabel, buttons);
    buttons.append(submit, switchMode, signOut);
    card.append(closeButton, title, message, form);
    modal.append(card);

    const levelsPanel = create('div', undefined, 'wh-modal');
    levelsPanel.hidden = true;
    levelsPanel.setAttribute('role', 'dialog');
    levelsPanel.setAttribute('aria-modal', 'true');
    const levelsCard = create('section', undefined, 'wh-card');
    const levelsClose = create('button', 'Close', 'wh-close');
    const levelsTitle = create('h2', 'Browse Levels');
    const levelsMessage = create('p', '', 'wh-message');
    const list = create('div');
    const loadMoreButton = create('button', 'Load more levels');
    loadMoreButton.type = 'button';
    loadMoreButton.hidden = true;
    levelsCard.append(levelsClose, levelsTitle, levelsMessage, list, loadMoreButton);
    levelsPanel.append(levelsCard);

    root.append(accountButton, levelsButton, modal, levelsPanel);
    document.head.append(style);
    document.body.append(root);

    let registerMode = false;
    const token = () => localStorage.getItem(TOKEN_KEY);
    const readUser = () => {
        try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
        catch { return null; }
    };
    const updateAccountButton = () => {
        const user = readUser();
        accountButton.textContent = user ? `Account: ${user.displayName}` : 'Sign in';
    };
    const api = async (path, options = {}) => {
        const headers = new Headers(options.headers || {});
        headers.set('Accept', 'application/json');
        if (token()) headers.set('Authorization', `Bearer ${token()}`);
        if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
        const response = await fetch(`${API}${path}`, { ...options, headers });
        const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status}).`);
        return payload;
    };
    const show = (panel) => { panel.hidden = false; };
    const hide = (panel) => { panel.hidden = true; };
    const setMessage = (node, text) => { node.textContent = text; };

    accountButton.addEventListener('click', () => {
        const user = readUser();
        registerMode = false;
        displayNameLabel.hidden = true;
        displayName.required = false;
        password.autocomplete = 'current-password';
        submit.textContent = 'Sign in';
        switchMode.hidden = Boolean(user);
        signOut.hidden = !user;
        message.textContent = user ? `Signed in as ${user.displayName} (${user.email}).` : 'Sign in or create a Wheels Happy account.';
        show(modal);
    });
    closeButton.addEventListener('click', () => hide(modal));
    modal.addEventListener('click', (event) => { if (event.target === modal) hide(modal); });
    switchMode.addEventListener('click', () => {
        registerMode = !registerMode;
        displayNameLabel.hidden = !registerMode;
        displayName.required = registerMode;
        password.autocomplete = registerMode ? 'new-password' : 'current-password';
        password.minLength = registerMode ? 10 : 0;
        submit.textContent = registerMode ? 'Create account' : 'Sign in';
        switchMode.textContent = registerMode ? 'I already have an account' : 'Create account';
        setMessage(message, registerMode ? 'Use at least 10 characters for your password.' : 'Sign in with your Wheels Happy account.');
    });
    signOut.addEventListener('click', async () => {
        signOut.disabled = true;
        setMessage(message, 'Signing out…');
        try {
            await api('/auth/logout', { method: 'POST' });
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(USER_KEY);
            window.location.reload();
        } catch (error) {
            setMessage(message, error.message);
        } finally {
            signOut.disabled = false;
        }
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        submit.disabled = true;
        setMessage(message, 'Connecting…');
        try {
            const payload = await api(`/auth/${registerMode ? 'register' : 'login'}`, {
                method: 'POST',
                body: JSON.stringify({ email: email.value, password: password.value, display_name: displayName.value })
            });
            localStorage.setItem(TOKEN_KEY, payload.token);
            localStorage.setItem(USER_KEY, JSON.stringify(payload.user));
            updateAccountButton();
            setMessage(message, 'Signed in. Reloading the game…');
            window.location.reload();
        } catch (error) {
            setMessage(message, error.message);
        } finally {
            submit.disabled = false;
        }
    });

    let levelOffset = 0;
    let totalLevels = 0;
    async function loadLevels(reset = true) {
        if (reset) {
            levelOffset = 0;
            totalLevels = 0;
            list.replaceChildren();
        }
        loadMoreButton.disabled = true;
        setMessage(levelsMessage, 'Loading levels…');
        try {
            const payload = await api(`/levels?limit=30&offset=${levelOffset}`);
            totalLevels = payload.total;
            for (const level of payload.levels) {
                const row = create('div', undefined, 'wh-level');
                const name = create('strong', level.title);
                const descriptionText = create('div', level.description || 'No description.', 'wh-muted');
                const rating = level.rating === null ? 'Unrated' : `Rating ${level.rating}`;
                const author = create('div', `By ${level.author} · ${rating}`, 'wh-muted');
                const loadButton = create('button', 'Load level');
                loadButton.type = 'button';
                loadButton.addEventListener('click', () => {
                    const gameFrame = document.getElementById('game-frame');
                    const url = new URL('/game.html', window.location.origin);
                    url.searchParams.set('wh_level', String(level.id));
                    if (gameFrame) gameFrame.src = url.href;
                    else window.location.href = url.href;
                });
                row.append(name, descriptionText, author, loadButton);
                list.append(row);
            }
            levelOffset += payload.levels.length;
            setMessage(levelsMessage, totalLevels ? `Showing ${levelOffset} of ${totalLevels} levels from get_level.hw` : 'No levels found.');
            loadMoreButton.hidden = levelOffset >= totalLevels;
        } catch (error) {
            setMessage(levelsMessage, error.message);
        } finally {
            loadMoreButton.disabled = false;
        }
    }
    loadMoreButton.addEventListener('click', () => loadLevels(false));
    levelsButton.addEventListener('click', () => { show(levelsPanel); loadLevels(); });
    levelsClose.addEventListener('click', () => hide(levelsPanel));
    levelsPanel.addEventListener('click', (event) => { if (event.target === levelsPanel) hide(levelsPanel); });
    updateAccountButton();
    if (token()) {
        api('/auth/me').catch(() => {
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(USER_KEY);
            updateAccountButton();
        });
    }
})();
