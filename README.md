# 🎮 Diddy vs Epstein

Jeu multijoueur style Rocket League.

## 📁 Structure

```
diddy-vs-epstein/
├── server.js          ← Serveur Node.js WebSocket
├── package.json
├── .gitignore
└── public/
    └── index.html     ← Le jeu complet
```

## 🚀 Déployer sur Render (gratuit)

### 1. Mettre sur GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TON_PSEUDO/diddy-vs-epstein.git
git push -u origin main
```

### 2. Déployer sur render.com
1. Créer un compte sur **render.com**
2. Cliquer **New + → Web Service**
3. Connecter le repo GitHub
4. Configurer :
   - **Runtime** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `node server.js`
   - **Plan** : `Free`
5. Cliquer **Create Web Service**

L'URL sera du type : `https://diddy-vs-epstein.onrender.com`

## 🖥️ Lancer en local
```bash
npm install
npm start
# → http://localhost:8080
```

## 🎮 Fonctionnalités
- ✅ Multijoueur WebSocket temps réel
- ✅ Collision entre joueurs
- ✅ Système XP / Levels
- ✅ Garage avec cadenas sur items non achetés
- ✅ Compte à rebours après but (Rocket League style)
- ✅ Tribunes avec spectateurs NPC
- ✅ Panel admin (mot de passe : Vaking.)
- ✅ Changement nom / logo joueur
- ✅ 3 maps avec décors uniques
