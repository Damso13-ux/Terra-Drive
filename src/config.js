// Configuration du projet.

/**
 * Archive PMTiles servant les routes, les batiments et les surfaces boisees.
 *
 * Laisser vide fait fonctionner le jeu sur l'API Overpass, ce qui reste le mode
 * par defaut : aucune configuration, mais un service benevole limite par adresse
 * IP. Renseigner une URL bascule sur les tuiles vectorielles, sans quota et bien
 * plus rapides.
 *
 * L'hebergement doit accepter les requetes de plage (`Range`) et autoriser le
 * CORS : un bucket Cloudflare R2 avec domaine public convient, et son offre
 * gratuite (10 Go, sortie non facturee) couvre tres largement ce besoin.
 *
 * Voir la section « Tuiles vectorielles » du README pour la marche a suivre.
 */
export const TILES_URL = '';

/**
 * Zoom des tuiles interrogees. 14 est le meilleur compromis pour ce jeu : la
 * geometrie des routes y est deja precise au metre, et une tuile couvre environ
 * 2,4 km, soit a peu pres une de nos cellules.
 */
export const TILES_ZOOM = 14;
