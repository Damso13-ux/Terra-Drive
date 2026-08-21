# Terra Drive

Conduire n'importe quelle route du monde réel, dans le navigateur.
Le terrain, le tracé des routes et l'imagerie sont téléchargés et assemblés **à la volée**
autour du joueur — rien n'est précalculé, aucun asset n'est livré avec le jeu.

Projet inspiré de [hop.earth](https://hop.earth), **réécrit intégralement à partir de zéro**
sur les mêmes briques ouvertes (le code de hop.earth est propriétaire).

## Lancer le projet

Aucune installation, aucune étape de build. Il suffit d'un serveur de fichiers statiques :

```bash
python -m http.server 8123
```

Puis ouvrir <http://localhost:8123>.

> Ouvrir `index.html` directement en `file://` ne marche pas : les modules ES et les
> requêtes CORS exigent un vrai serveur HTTP.

Pour tester depuis un téléphone sur le même réseau :

```bash
python -m http.server 8123 --bind 0.0.0.0
```

puis ouvrir `http://ADRESSE-IP-DU-PC:8123` sur le téléphone.

### En ligne

Le dépôt se publie tout seul sur GitHub Pages à chaque push sur `main`
(`.github/workflows/pages.yml`). Pour l'activer la première fois :
**Settings → Pages → Source → GitHub Actions**.

## Commandes

| Touche | Action |
|---|---|
| `Z Q S D` / `W A S D` / flèches | Conduire |
| `Espace` | Frein à main |
| `R` | Se replacer sur la route la plus proche |
| `C` | Changer de caméra (poursuite / capot / orbite) |
| `L` | Phares |
| `T` | Avancer l'heure de 3 h |
| `G` | Activer/désactiver ABS + antipatinage |
| `P` | Pause |
| `H` | Revenir au choix du lieu |
| `F3` | Panneau de diagnostic |

Les manettes sont gérées (gâchettes analogiques comprises).

### Sur téléphone

L'interface tactile apparaît automatiquement sur les appareils à écran tactile.

- **Direction : le gyroscope par défaut.** On incline le téléphone comme un volant.
  La première mesure sert de position de repos — inutile de tenir l'appareil à plat.
  « Recentrer l'inclinaison » est dans le menu.
- **Un volant apparaît sous le doigt** dès qu'on touche la moitié gauche de l'écran,
  et prend la main sur le gyroscope. Il s'efface au relâchement, avec une transition
  douce vers l'inclinaison. Rien n'occupe l'écran en permanence.
- **Pédales** en bas à droite, frein à main au-dessus.
- **Boutons** en haut à gauche : replacer, caméra, menu.

iOS exige une autorisation explicite pour le gyroscope : le bandeau « Diriger en
inclinant le téléphone ? » sert à la demander depuis un geste utilisateur, comme
Safari l'impose. Si elle est refusée, le volant tactile reste pleinement utilisable.

Le mode paysage est demandé : en portrait, un écran d'invite s'affiche.

L'URL contient le point de départ (`#latitude,longitude,nom`) : elle est partageable.

## Sources de données

| Donnée | Source | Licence |
|---|---|---|
| Altitude | Tuiles Terrarium (Copernicus DEM COP-DEM-GLO-30, IGN RGE ALTI®, CNIG) | © EU/ESA/IGN/CNIG |
| Routes | OpenStreetMap via Overpass API | ODbL |
| Imagerie | Esri World Imagery | conditions Esri |
| Recherche de lieux | Nominatim | ODbL |
| Fond de carte du sélecteur | tile.openstreetmap.org | ODbL |

Aucune clé d'API n'est nécessaire. Toutes ces sources sont soumises à des règles d'usage
raisonnable : ce projet est prévu pour un usage personnel et de développement. Une mise en
ligne publique demanderait de passer sur des tuiles auto-hébergées ou un fournisseur payant.

## Architecture

```
index.html          importmap (three.js, Leaflet) + squelette du DOM
styles.css
src/
  main.js           séquence de démarrage, boucle de jeu, câblage
  core/
    geo.js          Web-Mercator, tuiles slippy, repère métrique local
    net.js          file de requêtes prioritaire, retries, cache LRU
    input.js        clavier (AZERTY/QWERTY) + manette + tactile
    camera.js       caméra de poursuite à ressort, 3 modes
    device.js       détection de l'appareil et profil de qualité
  world/
    heightfield.js  tuiles d'altitude, 2 niveaux + repli garanti
    roads.js        réseau OSM, profils lissés, grille de collision
    roadmesh.js     rubans de chaussée fusionnés par cellule
    terrain.js      streaming des chunks, LOD, imagerie satellite
    ground.js       surface de collision unique (relief + chaussée)
    sky.js          ciel, soleil, brume, carte d'environnement
  vehicle/
    car.js          corps rigide + 4 roues, pneus à formule magique
    carview.js      carrosserie procédurale, feux, traces de gomme
  ui/
    picker.js       sélecteur de destination (Leaflet + Nominatim)
    hud.js          compteur, minicarte orientée, diagnostic
    touch.js        pédales, volant contextuel, gyroscope, menu
```

### Ce qui a été travaillé en priorité

**Fiabilité du chargement.** Le reproche principal fait au concept d'origine.
Ici : file de requêtes avec priorité par distance, retries à délai exponentiel,
miroirs multiples pour Overpass et les tuiles d'altitude, timeout dur sur chaque
requête, et surtout un **niveau d'altitude grossier chargé très large au démarrage**
qui garantit qu'une altitude est toujours disponible. Le monde est maillé
immédiatement puis raffiné : jamais de trou, jamais d'attente bloquante. Le panneau
de diagnostic (`F3`) montre en permanence ce qui charge et ce qui échoue.

**Qualité de conduite.** Modèle *raycast vehicle* : corps rigide à 6 degrés de liberté,
4 roues sur ressort-amortisseur avec butées, barres antiroulis, pneus à formule magique
(Pacejka simplifiée) avec cercle de friction et sensibilité à la charge, dynamique de
rotation de roue, boîte automatique, ABS et antipatinage débrayables. Pas fixe à 240 Hz.

**Le relief brut est trop bruité pour rouler dessus** (~3 m par échantillon) : le profil
altimétrique de chaque route est lissé sous contrainte, et le terrain est ensuite
*creusé* pour épouser la chaussée. C'est ce qui fait la différence entre une route en
tôle ondulée et une route roulable.

### Adaptation mobile

Un seul endroit arbitre qualité et fluidité : `qualityProfile()` dans
`src/core/device.js`. Sur téléphone : rayon de terrain réduit de 3 à 2 chunks,
maillage allégé (sauf l'anneau 0, celui sous les roues, qui reste fin car il ne
coûte qu'un chunk), `devicePixelRatio` plafonné à 1,5, ombres en 1024 sans
filtrage doux, physique à 180 Hz au lieu de 240.

L'intersection rayon/sol a aussi été réécrite : c'est le point chaud absolu du
moteur (4 roues × 180 à 240 pas par seconde). La bissection aveugle en ~20
évaluations a été remplacée par un point fixe qui converge en 3 itérations, avec
la bissection en filet pour les pentes fortes. Équilibre identique à la mesure :
13 536 N contre 13 531 N avant.

Deux réflexes propres au mobile : la position est mémorisée en `sessionStorage`
toutes les 2 s, et la perte du contexte WebGL (fréquente quand on change
d'application) recharge la page — le lieu est dans l'URL, la position en mémoire,
donc on reprend là où on était.

## État au 21 août 2026

Jouable de bout en bout. Vérifié en conditions réelles à Aix-en-Provence :
1 500+ routes chargées, 37 chunks de terrain, 0 échec de requête, la voiture se
pose et tient sur la chaussée (charge des 4 roues = 13 531 N ≈ poids exact du
véhicule, adhérence 0,99 sur route primaire).

### Points à surveiller

- **Overpass est le maillon fragile.** `overpass-api.de` limite par adresse IP et
  peut refuser toute connexion pendant plusieurs minutes si on le sollicite trop.
  Le repli sur `maps.mail.ru` fonctionne mais coûte ~45 s d'attente (le temps que
  le timeout du miroir principal expire). Si le démarrage est long, c'est ça.
- Si tu veux retirer le miroir `maps.mail.ru` (opéré par VK), il suffit de
  supprimer sa ligne dans `src/world/roads.js` — le jeu continue de fonctionner
  avec le miroir principal seul.
- **L'exposition a demandé trois passes** et mérite sans doute un dernier réglage
  à l'œil. Au départ tout était blanc : ciel `rgb(240,246,248)`, voiture saumon au
  lieu de rouge. Après réglage : ciel `rgb(195,222,235)`, carrosserie
  `rgb(157,44,48)`. Les boutons sont `toneMappingExposure` dans `src/main.js`, et
  l'intensité du soleil, de l'hémisphérique et de l'environnement dans
  `src/world/sky.js`. Attention : le ciel alimente aussi la carte d'environnement,
  donc l'éclaircir éclaircit toute la scène.
- La voiture flue très lentement à l'arrêt en pente (< 1 km/h) : la résistance au
  roulement s'annule sous 0,5 m/s. Cosmétique, mais à corriger.
- Pas de collision avec autre chose que le sol : ni bâtiments, ni glissières.

## Pistes suivantes

- Bâtiments OSM extrudés, végétation, garde-corps
- Son moteur (rien n'est audible pour l'instant)
- Modes course : chrono, départ/arrivée, partage par lien
- Multijoueur (serveur Node + websockets)
- Migration vers Vite + TypeScript quand le projet grossira
