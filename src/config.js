// Configuration du projet.

/**
 * Archive PMTiles servant les routes, les batiments et les surfaces boisees.
 *
 * Laisser vide fait fonctionner le jeu sur l'API Overpass, ce qui reste le mode
 * par defaut : aucune configuration, mais un service benevole limite par adresse
 * IP. Renseigner une URL bascule sur les tuiles vectorielles, sans quota et bien
 * plus rapides.
 *
 * L'archive ci-dessous couvre toute la France metropolitaine, Corse comprise,
 * en zoom 14 (4,5 Go sur Cloudflare R2). Hors de cette emprise, le jeu retombe
 * seul sur Overpass.
 *
 * Cette valeur n'est qu'un defaut : le panneau de reglages du jeu, section
 * « Source des donnees », la remplace sans toucher au code. La vider ramene a
 * Overpass partout.
 *
 * L'hebergement doit accepter les requetes de plage (`Range`) et autoriser le
 * CORS : un bucket Cloudflare R2 avec domaine public convient, et son offre
 * gratuite (10 Go, sortie non facturee) couvre tres largement ce besoin.
 */
const DEFAULT_TILES_URL =
  'https://pub-6bf0cf80774540b8b1a08c4a819e463d.r2.dev/france.pmtiles';

/** Adresse saisie dans les reglages, prioritaire sur le defaut. */
function storedTilesUrl() {
  try {
    return localStorage.getItem('terra:tilesUrl') || '';
  } catch {
    return ''; // navigation privee : on retombe sur le defaut
  }
}

export const TILES_URL = storedTilesUrl() || DEFAULT_TILES_URL;

/**
 * Zoom des tuiles interrogees. 14 est le meilleur compromis pour ce jeu : la
 * geometrie y est deja precise a moins d'un metre, une tuile couvre environ
 * 2,4 km — soit a peu pres une de nos cellules — et l'archive pese deux fois
 * moins qu'en zoom 15.
 */
export const TILES_ZOOM = 14;
