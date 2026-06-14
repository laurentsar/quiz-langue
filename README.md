# Quiz Langue

App de quiz de vocabulaire **anglais** et **espagnol**, 100 % hors-ligne.
Score, niveaux et séries enregistrés en local (par langue).

- Anglais : 4546 mots — niveaux A1, A2, B1, B2, C, D
- Espagnol : 4083 mots — niveaux A1-A2, B1-B2, C1-C2

Le code de l'app est dans `www/` (HTML/CSS/JS pur, aucune dépendance runtime).
Il sert à la fois de **PWA** et de contenu embarqué dans l'**APK** (via Capacitor).

## Utiliser tout de suite (PWA, sans build)
Ouvrir `www/index.html` depuis un serveur HTTPS (ou `localhost`) puis, sur Android,
menu Chrome → « Ajouter à l'écran d'accueil ». Fonctionne hors-ligne (service worker).

## Obtenir un vrai APK (build dans le cloud, aucun outil local)
1. Créer un dépôt GitHub et y pousser ce dossier :
   ```bash
   git remote add origin git@github.com:<toi>/quiz-langue.git
   git push -u origin main
   ```
2. GitHub Actions (`.github/workflows/build-apk.yml`) build automatiquement un APK debug.
3. Onglet **Actions** → dernier run → artéfact **quiz-langue-debug-apk** → `app-debug.apk`.
4. Copier l'APK sur le téléphone, autoriser « sources inconnues », installer.

> APK *debug* = signé avec la clé debug, installable directement. Pour un APK
> *release* signé (Play Store), ajouter un keystore + `assembleRelease`.

## Build sur un PC (x86) avec Android Studio
```bash
npm install
npx cap sync android
cd android && ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

## Données
Générées depuis Home Assistant :
- `python_scripts/quiz_wordlist_en_levels.py` → `www/data/wordlist_en.json`
- `python_scripts/quiz_wordlist_es_levels.py` → `www/data/wordlist_es.json`
