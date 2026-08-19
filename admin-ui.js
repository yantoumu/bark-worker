export function renderAdminHTML(version, build) {
    const privateKeyPlaceholder = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
    return `<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <meta name="theme-color" content="#f3f5f7">
    <meta name="robots" content="noindex,nofollow,noarchive">
    <title>Bark Worker 管理台</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%23137448'/%3E%3Ccircle cx='32' cy='29' r='12' fill='none' stroke='white' stroke-width='6'/%3E%3C/svg%3E">
    <link rel="stylesheet" href="./admin/styles.css">
    <script type="module" src="./admin/app.js"></script>
</head>
<body>
    <a class="skip-link" href="#main-content">跳到主要内容</a>

    <header class="site-header">
        <a class="brand" href="./admin" aria-label="Bark Worker 管理台首页">
            <span class="brand-mark" aria-hidden="true"><span></span></span>
            <span class="brand-copy">
                <strong>Bark</strong>
                <small>Worker Control</small>
            </span>
        </a>
        <div class="secure-status" aria-label="连接状态">
            <span class="status-dot" aria-hidden="true"></span>
            安全连接
        </div>
    </header>

    <main id="main-content">
        <section id="loading-view" class="loading-view" aria-label="正在载入">
            <div class="loader" aria-hidden="true"></div>
            <p>正在检查登录状态</p>
        </section>

        <section id="login-view" class="login-layout" hidden>
            <div class="login-intro">
                <p class="eyebrow">SELF-HOSTED CONTROL PLANE</p>
                <h1>安全管理你的<br>通知基础设施</h1>
                <p class="intro-copy">集中管理发送账号与 APNs 凭据。密码不可逆存储，私钥在写入 D1 前完成 AES-256-GCM 加密。</p>

                <dl class="security-list">
                    <div>
                        <dt><span class="security-number">01</span>登录凭据</dt>
                        <dd>PBKDF2-SHA256 与独立盐保护</dd>
                    </div>
                    <div>
                        <dt><span class="security-number">02</span>浏览器会话</dt>
                        <dd>HttpOnly 与 SameSite 严格隔离</dd>
                    </div>
                    <div>
                        <dt><span class="security-number">03</span>APNs 私钥</dt>
                        <dd>加密后保存，管理接口永不回显</dd>
                    </div>
                </dl>
            </div>

            <div class="auth-column">
                <div class="auth-heading">
                    <p class="section-kicker">管理员入口</p>
                    <h2 id="login-title">登录管理台</h2>
                    <p>使用 D1 中已创建的管理员账号继续。</p>
                </div>

                <form id="login-form" class="form-stack" aria-labelledby="login-title" novalidate>
                    <div class="field">
                        <label for="login-username">用户名</label>
                        <input id="login-username" name="username" type="text" autocomplete="username" minlength="3" maxlength="64" pattern="[A-Za-z0-9](?:[A-Za-z0-9._]|-){1,62}[A-Za-z0-9]" required autofocus>
                    </div>
                    <div class="field">
                        <label for="login-password">密码</label>
                        <input id="login-password" name="password" type="password" autocomplete="current-password" minlength="12" maxlength="128" required>
                        <label class="check-control" for="show-login-password">
                            <input id="show-login-password" type="checkbox">
                            <span>显示密码</span>
                        </label>
                    </div>
                    <p id="login-message" class="form-message" aria-live="polite"></p>
                    <button id="login-button" class="button button-primary button-full" type="submit">登录管理台</button>
                </form>

                <p class="auth-footnote">此页面不会在浏览器存储密码或访问令牌。</p>
            </div>
        </section>

        <section id="dashboard-view" class="dashboard" hidden>
            <aside class="sidebar" aria-label="管理导航">
                <div>
                    <p class="sidebar-label">工作区</p>
                    <nav>
                        <a class="nav-link active" href="#overview">服务概览</a>
                        <a class="nav-link" href="#users">发送用户</a>
                        <a class="nav-link" href="#apns">APNs 凭据</a>
                    </nav>
                </div>
                <div class="sidebar-version">
                    <span>运行版本</span>
                    <strong>${version}</strong>
                    <small>Build ${build}</small>
                </div>
            </aside>

            <div class="dashboard-content">
                <header class="dashboard-header">
                    <div>
                        <p class="section-kicker">Bark Worker</p>
                        <h1>管理概览</h1>
                    </div>
                    <div class="account-actions">
                        <div class="account-copy">
                            <strong id="current-username">管理员</strong>
                            <span id="current-role">admin</span>
                        </div>
                        <button id="logout-button" class="button button-secondary" type="button">退出登录</button>
                    </div>
                </header>

                <p id="global-message" class="global-message" aria-live="polite" hidden></p>

                <section id="overview" aria-labelledby="overview-title">
                    <div class="section-heading">
                        <div>
                            <p class="section-kicker">OVERVIEW</p>
                            <h2 id="overview-title">服务状态</h2>
                        </div>
                        <span class="live-badge"><span class="status-dot" aria-hidden="true"></span>在线</span>
                    </div>

                    <div class="metric-grid">
                        <article class="metric-card">
                            <span class="metric-label">身份认证</span>
                            <strong>已启用</strong>
                            <p>D1 用户与短期会话</p>
                        </article>
                        <article class="metric-card">
                            <span class="metric-label">APNs 凭据</span>
                            <strong id="apns-summary">检查中</strong>
                            <p id="apns-summary-detail">正在读取加密保险库</p>
                        </article>
                        <article class="metric-card">
                            <span class="metric-label">数据保护</span>
                            <strong>AES-256-GCM</strong>
                            <p>私钥静态加密存储</p>
                        </article>
                    </div>
                </section>

                <div class="management-grid">
                    <section id="users" class="panel" aria-labelledby="users-title">
                        <div class="panel-heading">
                            <div>
                                <p class="section-kicker">ACCESS</p>
                                <h2 id="users-title">添加用户</h2>
                            </div>
                            <span class="panel-index">01</span>
                        </div>
                        <p class="panel-description">为推送客户端创建独立账号。普通用户不能访问本管理台。</p>

                        <form id="user-form" class="form-stack" aria-labelledby="users-title" novalidate>
                            <div class="field-row">
                                <div class="field">
                                    <label for="new-username">用户名</label>
                                    <input id="new-username" name="username" type="text" autocomplete="off" minlength="3" maxlength="64" pattern="[A-Za-z0-9](?:[A-Za-z0-9._]|-){1,62}[A-Za-z0-9]" required>
                                </div>
                                <div class="field">
                                    <label for="new-role">权限</label>
                                    <select id="new-role" name="role">
                                        <option value="user">推送用户</option>
                                        <option value="admin">管理员</option>
                                    </select>
                                </div>
                            </div>
                            <div class="field">
                                <label for="new-password">初始密码</label>
                                <input id="new-password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required>
                                <span class="field-hint">至少 12 个字符，建议使用密码管理器生成。</span>
                            </div>
                            <p id="user-message" class="form-message" aria-live="polite"></p>
                            <button id="user-button" class="button button-primary" type="submit">创建用户</button>
                        </form>
                    </section>

                    <section id="apns" class="panel panel-wide" aria-labelledby="apns-title">
                        <div class="panel-heading">
                            <div>
                                <p class="section-kicker">APPLE PUSH</p>
                                <h2 id="apns-title">APNs 加密凭据</h2>
                            </div>
                            <span id="apns-status" class="status-badge" data-state="loading">检查中</span>
                        </div>
                        <p class="panel-description">上传 Apple Developer 生成的 .p8 私钥，并填写对应标识。保存后私钥不会再次显示。</p>

                        <form id="apns-form" class="form-stack" aria-labelledby="apns-title" novalidate>
                            <div class="field-row field-row-three">
                                <div class="field">
                                    <label for="team-id">Team ID</label>
                                    <input id="team-id" name="team_id" type="text" maxlength="128" autocomplete="off" required>
                                </div>
                                <div class="field">
                                    <label for="key-id">Key ID</label>
                                    <input id="key-id" name="key_id" type="text" maxlength="128" autocomplete="off" required>
                                </div>
                                <div class="field">
                                    <label for="apns-topic">Topic</label>
                                    <input id="apns-topic" name="topic" type="text" maxlength="255" placeholder="me.fin.bark" autocomplete="off" required>
                                </div>
                            </div>
                            <div class="field">
                                <label for="private-key-file">Apple 私钥文件</label>
                                <input id="private-key-file" class="file-input" type="file" accept=".p8,text/plain">
                                <span class="field-hint">选择 .p8 文件后会在下方预览，文件不会直接上传到其他服务。</span>
                            </div>
                            <div class="field">
                                <label for="private-key">私钥内容</label>
                                <textarea id="private-key" name="private_key" rows="7" spellcheck="false" autocomplete="off" placeholder="${privateKeyPlaceholder}" required></textarea>
                            </div>
                            <div class="form-footer">
                                <p id="apns-message" class="form-message" aria-live="polite"></p>
                                <button id="apns-button" class="button button-primary" type="submit">加密保存凭据</button>
                            </div>
                        </form>
                    </section>
                </div>
            </div>
        </section>
    </main>

    <footer class="site-footer">
        <span>Bark Worker ${version}</span>
        <span>凭据由你的 Cloudflare D1 与 Worker Secret 共同保护</span>
    </footer>
</body>
</html>`
}

export const ADMIN_STYLES = `
:root {
    color-scheme: light dark;
    --page: #f3f5f7;
    --surface: #ffffff;
    --surface-muted: #eef2ef;
    --surface-strong: #e4ebe6;
    --ink: #15231a;
    --ink-soft: #526158;
    --ink-faint: #7b8980;
    --line: #d8e0da;
    --line-strong: #c3cec6;
    --accent: #137448;
    --accent-hover: #0c5f39;
    --accent-soft: #e0f2e8;
    --danger: #b42318;
    --danger-soft: #fff0ee;
    --warning: #9a6700;
    --warning-soft: #fff5d6;
    --shadow: 0 18px 50px rgba(20, 39, 27, 0.09);
    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 18px;
    --max-width: 1180px;
    font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-synthesis: none;
}

* {
    box-sizing: border-box;
}

html {
    min-width: 320px;
    scroll-behavior: smooth;
}

body {
    min-height: 100vh;
    margin: 0;
    background: var(--page);
    color: var(--ink);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
}

button,
input,
select,
textarea {
    font: inherit;
}

button,
select {
    cursor: pointer;
}

a {
    color: inherit;
}

[hidden] {
    display: none !important;
}

.skip-link {
    position: fixed;
    z-index: 100;
    top: 12px;
    left: 12px;
    padding: 9px 13px;
    border-radius: var(--radius-sm);
    background: var(--ink);
    color: var(--surface);
    transform: translateY(-160%);
}

.skip-link:focus {
    transform: translateY(0);
}

.site-header {
    position: relative;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 72px;
    padding: 12px clamp(20px, 4vw, 56px);
    border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--page) 92%, transparent);
}

.brand {
    display: inline-flex;
    align-items: center;
    gap: 11px;
    text-decoration: none;
}

.brand-mark {
    position: relative;
    display: grid;
    width: 38px;
    height: 38px;
    place-items: center;
    overflow: hidden;
    border-radius: 11px;
    background: var(--accent);
}

.brand-mark::before,
.brand-mark::after,
.brand-mark span {
    position: absolute;
    width: 8px;
    height: 8px;
    border: 2px solid #ffffff;
    border-radius: 50%;
    content: "";
}

.brand-mark::before {
    transform: translate(-7px, 1px);
}

.brand-mark::after {
    transform: translate(7px, 1px);
}

.brand-mark span {
    transform: translateY(-7px);
}

.brand-copy {
    display: grid;
    line-height: 1.1;
}

.brand-copy strong {
    font-size: 16px;
    letter-spacing: -0.01em;
}

.brand-copy small {
    margin-top: 4px;
    color: var(--ink-faint);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
}

.secure-status,
.live-badge,
.status-badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 30px;
    padding: 5px 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    color: var(--ink-soft);
    font-size: 12px;
    font-weight: 700;
}

.status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #1da567;
    box-shadow: 0 0 0 3px color-mix(in srgb, #1da567 18%, transparent);
}

.loading-view {
    display: grid;
    min-height: calc(100vh - 136px);
    place-content: center;
    justify-items: center;
    gap: 14px;
    color: var(--ink-soft);
}

.loader {
    width: 30px;
    height: 30px;
    border: 3px solid var(--line);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}

.login-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(360px, 0.7fr);
    gap: clamp(48px, 9vw, 124px);
    align-items: center;
    width: min(var(--max-width), calc(100% - 40px));
    min-height: calc(100vh - 142px);
    margin: 0 auto;
    padding: clamp(56px, 8vw, 104px) 0;
}

.login-intro {
    max-width: 650px;
}

.eyebrow,
.section-kicker,
.sidebar-label {
    margin: 0 0 10px;
    color: var(--accent);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
}

.login-intro h1 {
    max-width: 700px;
    margin: 0;
    font-size: clamp(43px, 6.3vw, 78px);
    font-weight: 720;
    letter-spacing: -0.055em;
    line-height: 1.02;
}

.intro-copy {
    max-width: 590px;
    margin: 30px 0 0;
    color: var(--ink-soft);
    font-size: clamp(16px, 2vw, 19px);
    line-height: 1.75;
}

.security-list {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    margin: 50px 0 0;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--line);
}

.security-list div {
    min-width: 0;
    padding: 18px;
    background: var(--surface);
}

.security-list dt {
    display: grid;
    gap: 9px;
    font-size: 13px;
    font-weight: 750;
}

.security-number {
    color: var(--accent);
    font-size: 10px;
    letter-spacing: 0.1em;
}

.security-list dd {
    margin: 7px 0 0;
    color: var(--ink-faint);
    font-size: 12px;
    line-height: 1.55;
}

.auth-column {
    padding: clamp(28px, 4vw, 42px);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow);
}

.auth-heading h2,
.dashboard-header h1,
.section-heading h2,
.panel-heading h2 {
    margin: 0;
    letter-spacing: -0.035em;
    line-height: 1.12;
}

.auth-heading h2 {
    font-size: 30px;
}

.auth-heading > p:last-child {
    margin: 10px 0 0;
    color: var(--ink-soft);
    font-size: 14px;
}

.form-stack {
    display: grid;
    gap: 18px;
    margin-top: 30px;
}

.field,
.field label:not(.check-control) {
    display: grid;
}

.field {
    gap: 8px;
}

.field label:not(.check-control) {
    color: var(--ink);
    font-size: 13px;
    font-weight: 750;
}

input,
select,
textarea {
    width: 100%;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    outline: 0;
    background: var(--surface);
    color: var(--ink);
    transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease;
}

input,
select {
    min-height: 45px;
    padding: 9px 12px;
}

textarea {
    min-height: 150px;
    padding: 12px;
    resize: vertical;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.65;
}

input:hover,
select:hover,
textarea:hover {
    border-color: var(--ink-faint);
}

input:focus-visible,
select:focus-visible,
textarea:focus-visible,
button:focus-visible,
a:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--accent) 24%, transparent);
    outline-offset: 2px;
}

input:focus,
select:focus,
textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
}

.check-control {
    display: inline-flex;
    align-items: center;
    justify-self: start;
    gap: 8px;
    color: var(--ink-soft);
    font-size: 12px;
    cursor: pointer;
}

.check-control input {
    width: 16px;
    min-height: 16px;
    margin: 0;
    accent-color: var(--accent);
}

.field-hint {
    color: var(--ink-faint);
    font-size: 12px;
}

.file-input {
    padding: 6px;
    font-size: 12px;
}

.file-input::file-selector-button {
    min-height: 31px;
    margin-right: 10px;
    padding: 5px 10px;
    border: 0;
    border-radius: 6px;
    background: var(--surface-muted);
    color: var(--ink);
    font-weight: 700;
    cursor: pointer;
}

.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 9px 16px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    font-weight: 750;
    text-decoration: none;
    transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease;
}

.button:hover:not(:disabled) {
    transform: translateY(-1px);
}

.button:disabled {
    cursor: wait;
    opacity: 0.65;
}

.button-primary {
    background: var(--accent);
    color: #ffffff;
}

.button-primary:hover:not(:disabled) {
    background: var(--accent-hover);
}

.button-secondary {
    border-color: var(--line-strong);
    background: var(--surface);
    color: var(--ink);
}

.button-secondary:hover:not(:disabled) {
    border-color: var(--ink-faint);
    background: var(--surface-muted);
}

.button-full {
    width: 100%;
}

.form-message {
    min-height: 20px;
    margin: -3px 0 0;
    color: var(--ink-soft);
    font-size: 13px;
}

.form-message[data-kind="error"],
.global-message[data-kind="error"] {
    color: var(--danger);
}

.form-message[data-kind="success"],
.global-message[data-kind="success"] {
    color: var(--accent);
}

.auth-footnote {
    margin: 24px 0 0;
    padding-top: 20px;
    border-top: 1px solid var(--line);
    color: var(--ink-faint);
    font-size: 11px;
    text-align: center;
}

.dashboard {
    display: grid;
    grid-template-columns: 230px minmax(0, 1fr);
    width: min(1440px, 100%);
    min-height: calc(100vh - 120px);
    margin: 0 auto;
}

.sidebar {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 40px 24px 32px clamp(20px, 3vw, 42px);
    border-right: 1px solid var(--line);
}

.sidebar nav {
    display: grid;
    gap: 5px;
}

.nav-link {
    display: block;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    color: var(--ink-soft);
    font-size: 13px;
    font-weight: 700;
    text-decoration: none;
}

.nav-link:hover,
.nav-link.active {
    background: var(--accent-soft);
    color: var(--accent);
}

.sidebar-version {
    display: grid;
    gap: 3px;
    padding: 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--surface);
}

.sidebar-version span,
.sidebar-version small {
    color: var(--ink-faint);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
}

.sidebar-version strong {
    margin: 3px 0;
    font-size: 15px;
}

.dashboard-content {
    min-width: 0;
    padding: 38px clamp(22px, 4vw, 58px) 60px;
}

.dashboard-header,
.section-heading,
.panel-heading,
.account-actions,
.form-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
}

.dashboard-header {
    padding-bottom: 32px;
    border-bottom: 1px solid var(--line);
}

.dashboard-header h1 {
    font-size: 34px;
}

.account-copy {
    display: grid;
    justify-items: end;
    font-size: 13px;
}

.account-copy span {
    color: var(--ink-faint);
    font-size: 11px;
    text-transform: uppercase;
}

.global-message {
    margin: 20px 0 0;
    padding: 11px 13px;
    border: 1px solid currentColor;
    border-radius: var(--radius-sm);
    background: var(--surface);
    font-size: 13px;
}

.section-heading {
    margin: 38px 0 18px;
}

.section-heading h2,
.panel-heading h2 {
    font-size: 22px;
}

.metric-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
}

.metric-card,
.panel {
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--surface);
}

.metric-card {
    min-height: 142px;
    padding: 20px;
}

.metric-label {
    display: block;
    margin-bottom: 25px;
    color: var(--ink-faint);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.metric-card strong {
    display: block;
    font-size: 20px;
    letter-spacing: -0.02em;
}

.metric-card p {
    margin: 5px 0 0;
    color: var(--ink-soft);
    font-size: 12px;
}

.management-grid {
    display: grid;
    gap: 18px;
    margin-top: 18px;
}

.panel {
    padding: clamp(22px, 3vw, 32px);
}

.panel-index {
    color: var(--line-strong);
    font-size: 22px;
    font-weight: 800;
}

.panel-description {
    max-width: 720px;
    margin: 11px 0 0;
    color: var(--ink-soft);
    font-size: 13px;
}

.field-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(150px, 0.35fr);
    gap: 14px;
}

.field-row-three {
    grid-template-columns: repeat(3, minmax(0, 1fr));
}

.form-footer .form-message {
    flex: 1;
    margin: 0;
}

.status-badge[data-state="configured"] {
    border-color: color-mix(in srgb, var(--accent) 30%, var(--line));
    background: var(--accent-soft);
    color: var(--accent);
}

.status-badge[data-state="missing"] {
    border-color: color-mix(in srgb, var(--warning) 30%, var(--line));
    background: var(--warning-soft);
    color: var(--warning);
}

.site-footer {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    padding: 16px clamp(20px, 4vw, 56px);
    border-top: 1px solid var(--line);
    color: var(--ink-faint);
    font-size: 10px;
    letter-spacing: 0.03em;
}

@media (max-width: 900px) {
    .login-layout {
        grid-template-columns: 1fr;
        gap: 44px;
        width: min(660px, calc(100% - 36px));
    }

    .login-intro h1 {
        font-size: clamp(41px, 10vw, 62px);
    }

    .dashboard {
        grid-template-columns: 1fr;
    }

    .sidebar {
        display: none;
    }

    .dashboard-content {
        padding-top: 28px;
    }
}

@media (max-width: 680px) {
    .secure-status {
        padding-inline: 8px;
        font-size: 11px;
    }

    .login-layout {
        padding: 44px 0 56px;
    }

    .auth-column {
        order: -1;
    }

    .security-list,
    .metric-grid,
    .field-row,
    .field-row-three {
        grid-template-columns: 1fr;
    }

    .security-list {
        margin-top: 34px;
    }

    .auth-column {
        padding: 26px 20px;
    }

    .dashboard-header,
    .section-heading,
    .form-footer {
        align-items: flex-start;
        flex-direction: column;
    }

    .dashboard-header {
        gap: 22px;
    }

    .account-actions {
        width: 100%;
        justify-content: space-between;
    }

    .account-copy {
        justify-items: start;
    }

    .form-footer .button {
        width: 100%;
    }

    .button {
        min-height: 48px;
    }

    .site-footer {
        flex-direction: column;
        gap: 5px;
    }
}

@media (prefers-color-scheme: dark) {
    :root {
        --page: #0f1612;
        --surface: #161f19;
        --surface-muted: #1d2921;
        --surface-strong: #243129;
        --ink: #edf5ef;
        --ink-soft: #a6b5aa;
        --ink-faint: #7f9185;
        --line: #2a382f;
        --line-strong: #3a4c40;
        --accent: #55d590;
        --accent-hover: #70e3a5;
        --accent-soft: #173625;
        --danger: #ff8a80;
        --danger-soft: #351b1a;
        --warning: #f2c45b;
        --warning-soft: #332b18;
        --shadow: 0 20px 55px rgba(0, 0, 0, 0.24);
    }

    .button-primary {
        color: #082015;
    }
}

@media (prefers-reduced-motion: reduce) {
    html {
        scroll-behavior: auto;
    }

    *,
    *::before,
    *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
    }
}
`

export const ADMIN_SCRIPT = `
const elements = {
    loading: document.querySelector('#loading-view'),
    login: document.querySelector('#login-view'),
    dashboard: document.querySelector('#dashboard-view'),
    loginForm: document.querySelector('#login-form'),
    loginButton: document.querySelector('#login-button'),
    loginMessage: document.querySelector('#login-message'),
    loginPassword: document.querySelector('#login-password'),
    showLoginPassword: document.querySelector('#show-login-password'),
    currentUsername: document.querySelector('#current-username'),
    currentRole: document.querySelector('#current-role'),
    logoutButton: document.querySelector('#logout-button'),
    globalMessage: document.querySelector('#global-message'),
    userForm: document.querySelector('#user-form'),
    userButton: document.querySelector('#user-button'),
    userMessage: document.querySelector('#user-message'),
    apnsForm: document.querySelector('#apns-form'),
    apnsButton: document.querySelector('#apns-button'),
    apnsMessage: document.querySelector('#apns-message'),
    apnsStatus: document.querySelector('#apns-status'),
    apnsSummary: document.querySelector('#apns-summary'),
    apnsSummaryDetail: document.querySelector('#apns-summary-detail'),
    privateKeyFile: document.querySelector('#private-key-file'),
    privateKey: document.querySelector('#private-key'),
    teamID: document.querySelector('#team-id'),
    keyID: document.querySelector('#key-id'),
    topic: document.querySelector('#apns-topic'),
}

function endpoint(path) {
    return new URL('.' + path, document.baseURI)
}

async function api(path, options = {}) {
    const headers = new Headers(options.headers)
    headers.set('accept', 'application/json')
    let body = options.body
    if (body !== undefined && typeof body !== 'string') {
        headers.set('content-type', 'application/json')
        body = JSON.stringify(body)
    }
    const response = await fetch(endpoint(path), {
        ...options,
        headers,
        body,
        credentials: 'same-origin',
    })
    let payload = null
    try {
        payload = await response.json()
    } catch (error) {
        payload = null
    }
    if (!response.ok) {
        const requestError = new Error(payload?.message || 'request failed')
        requestError.status = response.status
        throw requestError
    }
    return payload
}

function showView(name) {
    elements.loading.hidden = name !== 'loading'
    elements.login.hidden = name !== 'login'
    elements.dashboard.hidden = name !== 'dashboard'
}

function setMessage(element, text = '', kind = '') {
    element.textContent = text
    if (kind) element.dataset.kind = kind
    else delete element.dataset.kind
}

function setGlobalMessage(text = '', kind = '') {
    elements.globalMessage.hidden = !text
    setMessage(elements.globalMessage, text, kind)
}

function setBusy(button, busy, idleLabel, busyLabel) {
    button.disabled = busy
    button.textContent = busy ? busyLabel : idleLabel
}

function friendlyError(error) {
    if (error?.status === 401) return '用户名或密码错误，请重新输入。'
    if (error?.status === 403) return '当前账号没有执行此操作的权限。'
    if (error?.status === 409) return '该用户名已经存在。'
    if (error?.status === 429) return '尝试次数过多，请稍后再试。'
    if (error?.status === 503) return '服务配置暂不可用，请检查 Worker 配置。'
    if (error?.message === 'APNs credentials are invalid') return 'APNs 凭据格式无效，请核对 .p8 私钥与标识。'
    return '请求失败，请稍后重试。'
}

function showLogin(message = '') {
    showView('login')
    elements.loginForm.reset()
    elements.loginPassword.type = 'password'
    setMessage(elements.loginMessage, message, message ? 'error' : '')
    setGlobalMessage()
    window.requestAnimationFrame(() => document.querySelector('#login-username').focus())
}

async function loadAPNsStatus() {
    elements.apnsStatus.textContent = '检查中'
    elements.apnsStatus.dataset.state = 'loading'
    try {
        const payload = await api('/admin/apns')
        const data = payload?.data || {}
        if (data.configured) {
            elements.apnsStatus.textContent = '已加密保存'
            elements.apnsStatus.dataset.state = 'configured'
            elements.apnsSummary.textContent = '已配置'
            elements.apnsSummaryDetail.textContent = data.updated_at
                ? '更新于 ' + new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(data.updated_at * 1000)
                : '加密凭据可用'
            elements.teamID.value = data.team_id || ''
            elements.keyID.value = data.key_id || ''
            elements.topic.value = data.topic || ''
        } else {
            elements.apnsStatus.textContent = '尚未配置'
            elements.apnsStatus.dataset.state = 'missing'
            elements.apnsSummary.textContent = '未配置'
            elements.apnsSummaryDetail.textContent = '需要写入新的 Apple 推送凭据'
        }
    } catch (error) {
        if (error.status === 401) {
            showLogin('登录已过期，请重新登录。')
            return
        }
        elements.apnsStatus.textContent = '读取失败'
        elements.apnsStatus.dataset.state = 'missing'
        elements.apnsSummary.textContent = '不可用'
        elements.apnsSummaryDetail.textContent = friendlyError(error)
    }
}

async function showDashboard(user) {
    if (user?.role !== 'admin') {
        try { await api('/auth/logout', { method: 'POST' }) } catch (error) { /* session expires naturally */ }
        showLogin('该账号不是管理员，无法进入管理台。')
        return
    }
    elements.currentUsername.textContent = user.username
    elements.currentRole.textContent = user.role
    showView('dashboard')
    await loadAPNsStatus()
}

elements.showLoginPassword.addEventListener('change', () => {
    elements.loginPassword.type = elements.showLoginPassword.checked ? 'text' : 'password'
})

elements.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!elements.loginForm.reportValidity()) return
    setMessage(elements.loginMessage)
    setBusy(elements.loginButton, true, '登录管理台', '正在登录')
    const form = new FormData(elements.loginForm)
    try {
        const payload = await api('/auth/login', {
            method: 'POST',
            body: {
                username: form.get('username'),
                password: form.get('password'),
            },
        })
        await showDashboard(payload?.data?.user)
    } catch (error) {
        setMessage(elements.loginMessage, friendlyError(error), 'error')
    } finally {
        setBusy(elements.loginButton, false, '登录管理台', '正在登录')
    }
})

elements.logoutButton.addEventListener('click', async () => {
    setBusy(elements.logoutButton, true, '退出登录', '正在退出')
    try {
        await api('/auth/logout', { method: 'POST' })
        showLogin()
    } catch (error) {
        setGlobalMessage(friendlyError(error), 'error')
    } finally {
        setBusy(elements.logoutButton, false, '退出登录', '正在退出')
    }
})

elements.userForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!elements.userForm.reportValidity()) return
    setMessage(elements.userMessage)
    setBusy(elements.userButton, true, '创建用户', '正在创建')
    const form = new FormData(elements.userForm)
    try {
        const payload = await api('/admin/users', {
            method: 'POST',
            body: {
                username: form.get('username'),
                password: form.get('password'),
                role: form.get('role'),
            },
        })
        elements.userForm.reset()
        setMessage(elements.userMessage, '用户 ' + payload.data.user.username + ' 已创建。', 'success')
    } catch (error) {
        if (error.status === 401) return showLogin('登录已过期，请重新登录。')
        setMessage(elements.userMessage, friendlyError(error), 'error')
    } finally {
        setBusy(elements.userButton, false, '创建用户', '正在创建')
    }
})

elements.privateKeyFile.addEventListener('change', async () => {
    const file = elements.privateKeyFile.files?.[0]
    if (!file) return
    if (file.size > 16384) {
        setMessage(elements.apnsMessage, '私钥文件过大，请选择正确的 .p8 文件。', 'error')
        elements.privateKeyFile.value = ''
        return
    }
    try {
        elements.privateKey.value = await file.text()
        setMessage(elements.apnsMessage, '已读取 ' + file.name + '，确认标识后即可加密保存。')
    } catch (error) {
        setMessage(elements.apnsMessage, '无法读取该文件。', 'error')
    }
})

elements.apnsForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!elements.apnsForm.reportValidity()) return
    setMessage(elements.apnsMessage)
    setBusy(elements.apnsButton, true, '加密保存凭据', '正在加密保存')
    const form = new FormData(elements.apnsForm)
    try {
        await api('/admin/apns', {
            method: 'PUT',
            body: {
                private_key: form.get('private_key'),
                team_id: form.get('team_id'),
                key_id: form.get('key_id'),
                topic: form.get('topic'),
            },
        })
        elements.privateKey.value = ''
        elements.privateKeyFile.value = ''
        setMessage(elements.apnsMessage, '凭据已加密保存，私钥内容已从页面清除。', 'success')
        await loadAPNsStatus()
    } catch (error) {
        if (error.status === 401) return showLogin('登录已过期，请重新登录。')
        setMessage(elements.apnsMessage, friendlyError(error), 'error')
    } finally {
        setBusy(elements.apnsButton, false, '加密保存凭据', '正在加密保存')
    }
})

async function start() {
    showView('loading')
    try {
        const payload = await api('/auth/session')
        if (payload?.data?.authenticated) await showDashboard(payload.data.user)
        else showLogin()
    } catch (error) {
        showLogin(friendlyError(error))
    }
}

start()
`
