# Enedis Weather Checker

Application web de supervision météorologique et réseau électrique, permettant de consulter en temps réel les conditions météo et l'état du réseau Enedis pour une adresse ou des coordonnées géographiques données.

---

## Table des matières

1. [Architecture](#architecture)
2. [Fonctionnalités](#fonctionnalités)
3. [Installation](#installation)
4. [Configuration](#configuration)
5. [Utilisation](#utilisation)
6. [Fonctionnement du proxy](#fonctionnement-du-proxy)
7. [Structure des fichiers](#structure-des-fichiers)
8. [Dépendances](#dépendances)

---

## Architecture

Le système est composé de deux éléments indépendants :

```
┌─────────────────────────────────┐
│  Navigateur                     │
│  frontend/enedis-checker.html   │
│                                 │
│  ┌───────────┐ ┌─────────────┐  │
│  │ open-meteo│ │ api-adresse │  │
│  │ (météo)   │ │ (géocodage) │  │
│  └───────────┘ └─────────────┘  │
│         │                       │
│         ▼                       │
│  ┌─────────────────────────┐    │
│  │  Proxy Enedis           │    │
│  │  (Render.com)           │    │
│  │  Node.js + Playwright   │    │
│  │                         │    │
│  │  GET /enedis?insee=...  │    │
│  └────────────┬────────────┘    │
└───────────────┼─────────────────┘
                │ Playwright headless
                ▼
        www.enedis.fr
        (page rendue JS)
```

- Le **front-end** est un fichier HTML autonome, sans dépendance serveur, qui s'ouvre directement dans le navigateur.
- Le **proxy** est un service Node.js déployé sur Render.com, qui scrape Enedis via un navigateur headless Chromium (Playwright).

---

## Fonctionnalités

### Météo (open-meteo.com — sans clé API)
- Rafales de vent en km/h avec seuil d'alerte configurable
- Détection d'orage (codes WMO 95–99)
- Détection de neige/grêle (codes WMO 71–77, 85–86)
- Graphe historique + prévision du vent (3h passées / 3h à venir)

### Réseau Enedis
- Double vérification : résultats à l'**adresse précise** et à la **commune**
- Détection des états : INCIDENT / TRAVAUX / VIGILANCE / COURANT RÉTABLI / NON
- Date de rétablissement prévue (`.js-CoupureDate`) quand disponible
- Détection des zones non couvertes par Enedis (autres GRD)
- Lien direct vers la page Enedis correspondante

### Géocodage
- Saisie par **adresse libre** (rue, ville, code postal)
- Saisie par **coordonnées Lambert II étendu** (X/Y Refsite Orange)
- Conversion Lambert II → WGS84 intégrée (projection NTF)
- Reverse geocoding via api-adresse.data.gouv.fr

---

## Installation

### Prérequis
- Compte [GitHub](https://github.com) (gratuit)
- Compte [Render.com](https://render.com) (gratuit)

### Étape 1 — Déployer le proxy sur Render

1. Créer un nouveau repository GitHub nommé `enedis-proxy`
2. Y déposer les fichiers du dossier `proxy/` :
   ```
   enedis-proxy-server.js
   package.json
   Dockerfile
   render.yaml
   ```
3. Sur [render.com](https://render.com), cliquer **New → Web Service**
4. Connecter le repository GitHub `enedis-proxy`
5. Paramètres de déploiement :

   | Paramètre      | Valeur                        |
   |----------------|-------------------------------|
   | Runtime        | Docker                        |
   | Dockerfile     | `./Dockerfile`                |
   | Port           | `3001`                        |
   | Health Check   | `/health`                     |
   | Plan           | Free (ou Starter à $7/mois)   |

6. Cliquer **Deploy** et attendre la fin du build (~3 minutes)
7. Récupérer l'URL du service, ex : `https://enedis-proxy-xxxx.onrender.com`

> ⚠️ **Plan Free Render** : le service se met en veille après 15 minutes d'inactivité.
> Le premier appel après une période d'inactivité prend environ 30 secondes.
> Le plan Starter ($7/mois) maintient le service actif en permanence.

### Étape 2 — Configurer le front-end

Ouvrir `frontend/enedis-checker.html` et remplacer à la ligne ~350 :

```javascript
const PROXY_URL = 'https://VOTRE-SERVICE.onrender.com';
```

par l'URL réelle du service déployé à l'étape 1.

### Étape 3 — Utilisation

Ouvrir `frontend/enedis-checker.html` directement dans un navigateur.
Aucun serveur web n'est nécessaire pour le front-end.

---

## Configuration

### Seuil de rafales

Le champ **Seuil rafales (km/h)** dans l'interface (défaut : 70 km/h) détermine à partir de quelle vitesse de vent l'alerte est déclenchée. Ce seuil est typiquement configuré selon les critères opérationnels du client (ex : seuil d'intervention réseau Orange).

### URL du proxy

```javascript
// frontend/enedis-checker.html — ligne ~350
const PROXY_URL = 'https://enedis-proxy-xxxx.onrender.com';
```

---

## Utilisation

### Saisie par adresse

Entrer une adresse complète ou partielle dans le champ **Adresse** :
- `10 rue de la Paix Paris` → résultats adresse + commune
- `Lyon 69001` → résultats commune uniquement
- `L'Abergement-Clémenciat` → résultats commune

### Saisie par coordonnées Lambert II

Entrer les valeurs X et Y dans les champs correspondants (système Lambert II étendu, mètres) :
- Ces coordonnées sont disponibles dans les outils de supervision réseau Orange (Refsite, etc.)
- La conversion en WGS84 est effectuée automatiquement par le front-end

### Lecture des résultats

Les résultats apparaissent en deux temps :

**1. Météo (~1 seconde)**
- Tuiles Rafales, Orage, Neige affichées immédiatement
- Tuiles Enedis en gris avec indicateur de chargement
- Graphe vent lancé en parallèle

**2. Enedis (~10–20 secondes)**
- Tuile **Enedis — Adresse** (si rue disponible) : état pour la rue spécifique
- Tuile **Enedis — Commune** : état global de la commune
- Bannière ÉVÈNEMENT / NORMAL mise à jour

### Codes couleur des tuiles Enedis

| Couleur | État |
|---------|------|
| 🟢 Vert | Aucune coupure |
| 🔴 Rouge | Incident / panne en cours |
| 🟡 Orange | Travaux en cours |
| ⚪ Gris | Zone non couverte par Enedis |

---

## Fonctionnement du proxy

Le proxy est nécessaire car la page Enedis de résultats est entièrement rendue côté client (JavaScript). Un simple `fetch()` depuis le navigateur retourne le HTML statique sans les données de pannes/travaux, et est de plus bloqué par la politique CORS d'Enedis.

### Flux de traitement

```
1. Le front-end appelle GET /enedis?insee=01001&lat=46.15&lon=4.92&...

2. Le proxy vérifie le cache (TTL 2 minutes par commune+adresse)

3. Playwright lance Chromium headless et charge :
   a. https://www.enedis.fr/resultat-panne-interruption?type=street&...
      → résultats pour la rue spécifique
   b. https://www.enedis.fr/resultat-panne-interruption?type=municipality&...
      → résultats pour la commune entière

4. Pour chaque page, Playwright attend qu'un des blocs résultats
   devienne visible dans le DOM :
   ┌─────────────────────────────────────────────────┐
   │ Sélecteur CSS              │ Signification       │
   ├────────────────────────────┼─────────────────────┤
   │ [class*="bloc-incident"]   │ Incident en cours   │
   │ [class*="bloc-travaux"]    │ Travaux en cours     │
   │ [class*="bloc-vigilance"]  │ Vigilance            │
   │ [class*="bloc-courant-     │ Courant rétabli     │
   │   retabli"]                │                     │
   │ [class*="bloc-aucune-      │ Aucune coupure      │
   │   coupure"]                │                     │
   │ .js-modal-resultPanne      │ Zone non couverte   │
   └────────────────────────────┴─────────────────────┘

   Note : Enedis place tous ces blocs dans le HTML initial
   avec la classe CSS `template-hidden`. Le JavaScript de la
   page en rend exactement un visible selon le résultat réel.
   Le proxy détecte lequel est visible via window.getComputedStyle().

5. La date de rétablissement est lue dans l'élément
   .js-CoupureDate, peuplé par le JS Enedis avec la date estimée.

6. Les résultats des deux pages sont fusionnés et retournés :
   {
     nonCouvert: bool,
     incident:   bool,       // street OR commune
     travaux:    bool,       // street OR commune
     count:      int,        // nombre de clients impactés
     dateRetablissement: str,
     blocStreet:  str,       // état détaillé adresse
     blocCommune: str,       // état détaillé commune
     urlStreet:  str,
     urlCommune: str
   }

7. Le résultat est mis en cache 2 minutes (évite de surcharger Enedis)
```

### Gestion des erreurs

- **Timeout Playwright (12s)** : si aucun bloc résultat ne devient visible, le proxy retourne l'état du DOM tel quel
- **Browser crash** : le browser Chromium est recréé automatiquement au prochain appel
- **Erreur réseau** : le front-end affiche les résultats météo et signale Enedis indisponible

---

## Structure des fichiers

```
enedis-webapp/
├── proxy/
│   ├── enedis-proxy-server.js   # Serveur Express + Playwright
│   ├── package.json             # Dépendances Node.js
│   ├── Dockerfile               # Image Docker Playwright v1.59.1
│   └── render.yaml              # Configuration déploiement Render
└── frontend/
    └── enedis-checker.html      # Application web autonome (HTML/CSS/JS)
```

---

## Dépendances

### Proxy (Node.js)
| Package | Version | Rôle |
|---------|---------|------|
| express | ^4.18 | Serveur HTTP |
| playwright | 1.59.1 | Navigateur headless Chromium |
| cors | ^2.8 | Headers CORS pour le front-end |

### Front-end (CDN, sans installation)
| Ressource | Rôle |
|-----------|------|
| Chart.js 4.4 | Graphe vent |
| api-adresse.data.gouv.fr | Géocodage adresses françaises |
| api.open-meteo.com | Données météo temps réel |
| geo.api.gouv.fr | Données communes INSEE |

### Infrastructure
| Service | Rôle | Coût |
|---------|------|------|
| Render.com | Hébergement proxy | Gratuit / $7/mois |
| GitHub | Dépôt source proxy | Gratuit |
