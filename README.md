# NexDrop – Secure File Server

<div align="center">

![NexDrop](https://img.shields.io/badge/NexDrop-v2.0-6366f1?style=for-the-badge&logo=hard-drive)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=node.js)
![Express](https://img.shields.io/badge/Express-4.x-000000?style=for-the-badge&logo=express)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

**A cross-platform, secure, GUI-based file server with multi-user support,  
real-time search, file preview, and a full admin dashboard.**

</div>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔐 **JWT Authentication** | Secure login & registration with bcrypt-hashed passwords |
| 🔒 **Rate Limiting** | Brute-force protection on auth routes (10 req / 15 min) |
| 🛡️ **Security Headers** | Helmet.js middleware for HTTP security hardening |
| 🔍 **Real-time Search** | Instant recursive file search with debouncing |
| 👁️ **File Preview** | Inline preview for images, video, audio, and text files |
| 📁 **Move Files** | Move files between folders with a visual folder picker |
| 🔗 **Secure File Sharing** | Password-protected links with expiry and download limits |
| 📊 **Admin Dashboard** | System stats, user management, quota control, activity logs |
| 📱 **Responsive UI** | Fully mobile-optimized with hamburger menu and FAB |
| ☁️ **Real Upload Progress** | Accurate XHR-based progress bars (not simulated) |
| 🗂️ **Multi-User Storage** | Per-user isolated storage with configurable quotas |
| 🌙 **Dark UI** | Premium glassmorphism dark design |

---

## 🚀 Quick Start

### Prerequisites
- **Node.js** v18 or higher → [Download](https://nodejs.org)
- **npm** (comes with Node.js)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/prashantsaha18/FILE-SHARING-APP.git
cd FILE-SHARING-APP

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env and set a strong JWT_SECRET

# 4. Start the server
npm start
```

Open your browser at **http://localhost:3000**

### Windows Quick Start
Double-click `start.bat` — it installs dependencies automatically.

### Linux/macOS Quick Start
```bash
chmod +x start.sh && ./start.sh
```

---

## 🔑 Default Credentials

| Username | Password  | Role  |
|----------|-----------|-------|
| `admin`  | `admin123`| Admin |

> ⚠️ **Change the admin password immediately after first login in a production environment.**

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| **Runtime** | Node.js 18+ |
| **Framework** | Express.js 4 |
| **Auth** | JWT (jsonwebtoken) + bcryptjs |
| **Security** | Helmet.js + express-rate-limit |
| **Upload** | Multer (memory storage) |
| **Database** | JSON file store (atomic writes, zero-dependency) |
| **Frontend** | Vanilla HTML / CSS / JS (no framework) |
| **Icons** | Lucide Icons (CDN) |
| **Fonts** | Outfit + Inter (Google Fonts) |

> **Why a JSON database?** This project is intentionally dependency-light for portability and easy demonstration. In a production scenario, a proper SQL or NoSQL database (e.g., SQLite, PostgreSQL) would be used.

---

## 📁 Project Structure

```
NexDrop/
├── server.js          # Express app: routes, auth, rate limiting
├── auth.js            # JWT middleware (requireAuth, requireAdmin)
├── db.js              # Async JSON database layer (users, shares, logs)
├── fileManager.js     # Secure file ops (list, upload, search, move, delete)
├── public/
│   ├── index.html     # SPA shell with all modals
│   ├── app.js         # Frontend controller (~800 lines)
│   └── style.css      # Premium dark theme + responsive design
├── storage/users/     # Per-user file storage (auto-created)
├── data/              # JSON database files (auto-created)
├── .env.example       # Environment configuration template
├── start.bat          # Windows one-click launcher
└── start.sh           # Linux/macOS launcher
```

---

## 🔒 Security Features

- **JWT tokens** expire after 7 days
- **bcrypt** password hashing (cost factor 10)
- **Rate limiting**: 10 login/register attempts per 15 minutes per IP
- **Helmet.js**: Sets `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, and other security headers
- **Path traversal prevention**: All file paths are validated to stay within the user's home directory
- **Input validation**: Username regex, minimum password length, file type checks

---

## 📖 API Reference

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login, returns JWT |
| GET  | `/api/auth/me` | Get current user info |

### Files
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/api/files/list?path=` | List directory contents |
| GET  | `/api/files/search?q=` | Recursive file search |
| GET  | `/api/files/info?path=` | Get file metadata |
| POST | `/api/files/upload` | Upload files (multipart) |
| GET  | `/api/files/download?path=` | Download file |
| POST | `/api/files/create-folder` | Create directory |
| POST | `/api/files/rename` | Rename file/folder |
| POST | `/api/files/move` | Move file to folder |
| DELETE | `/api/files/delete?path=` | Delete file/folder |

### Shares
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/share/create` | Create share link |
| GET  | `/api/share/list` | List user's shares |
| GET  | `/api/share/info/:token` | Get share info (public) |
| POST | `/api/share/download/:token` | Download shared file |
| DELETE | `/api/share/delete/:token` | Delete share link |

### Admin (requires admin role)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/api/admin/users` | List all users |
| PUT  | `/api/admin/users/:username/quota` | Set storage quota |
| PUT  | `/api/admin/users/:username/status` | Suspend/activate user |
| DELETE | `/api/admin/users/:username` | Delete user |
| GET  | `/api/admin/system-stats` | Server statistics |
| GET  | `/api/admin/logs` | Activity logs |

---

## ⚙️ Configuration

Copy `.env.example` to `.env`:

```env
PORT=3000
JWT_SECRET=your_super_secret_jwt_key_change_me_in_production
```

---

## 📜 License

MIT © 2026 Prashant Saha
