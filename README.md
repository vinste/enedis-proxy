# Enedis Webapp - Supervision météo & pannes réseau

## Structure
- proxy/    → serveur Node.js à déployer sur Render.com
- frontend/ → page HTML à ouvrir dans le navigateur

## Déploiement proxy (Render.com)

1. Créer un repo GitHub avec le contenu du dossier proxy/
2. Sur render.com → New Web Service → connecter le repo
3. Runtime : Docker
4. Port : 3001
5. Plan : Free (ou Starter $7/mois pour éviter la mise en veille)
6. Récupérer l'URL du service (ex: https://enedis-proxy-xxxx.onrender.com)

## Configuration front-end

Dans frontend/enedis-checker.html, remplacer :
  const PROXY_URL = 'https://VOTRE-SERVICE.onrender.com';
par l'URL réelle de votre service Render.

## Utilisation

Ouvrir enedis-checker.html dans le navigateur.
Saisir une adresse ou des coordonnées X/Y (Lambert II).
Le résultat affiche :
  - Rafales, orage, neige (open-meteo)
  - Enedis : INCIDENT / TRAVAUX / NON COUVERT / NON
  - Graphe vent 3h passées + 3h futures
