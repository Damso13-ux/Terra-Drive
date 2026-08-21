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

L'URL contient le point de départ (`#latitude,longitude,nom`) : elle est partageable.

## Sources de données

| Donnée | Source | Licence |
|---|---|---|
| Altitude | Tuiles Terrarium (Copernicus DEM, IGN RGE ALTI®, CNIG) | voir `ATTRIBUTIONS.md` |
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
    input.js        clavier (AZERTY/QWERTY) + manette
    camera.js       caméra de poursuite à ressort, 3 modes
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

## Pistes suivantes

- Bâtiments OSM extrudés, végétation, garde-corps
- Modes course : chrono, départ/arrivée, partage par lien
- Multijoueur (serveur Node + websockets)
- Migration vers Vite + TypeScript quand le projet grossira
