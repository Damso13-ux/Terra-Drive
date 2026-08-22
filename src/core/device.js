// Detection de l'appareil et profils de qualite.
//
// On ne renifle pas la chaine user-agent : elle ment. On se fie au type de
// pointeur et a la presence d'un ecran tactile, ce qui decrit ce qui compte
// vraiment ici — est-ce qu'il y a un clavier, et est-ce qu'on rend sur un GPU
// de telephone.

export function detectDevice() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const touch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  const smallSide = Math.min(screen.width, screen.height);
  const mobile = coarse && touch && smallSide <= 900;

  return {
    mobile,
    tablet: mobile && smallSide > 600,
    touch,
    cores: navigator.hardwareConcurrency || 4,
  };
}

export const PRESETS = [
  { id: 'auto', name: 'Automatique', hint: "selon l'appareil" },
  { id: 'bas', name: 'Basse', hint: 'priorite a la fluidite' },
  { id: 'moyen', name: 'Moyenne', hint: 'equilibre' },
  { id: 'eleve', name: 'Elevee', hint: "priorite a l'image" },
];

/** Le preset retenu quand l'utilisateur laisse le choix a la machine. */
export function autoPreset(device) {
  if (!device.mobile) return 'eleve';
  return device.cores <= 4 ? 'bas' : 'moyen';
}

const PROFILES = {
  bas: {
    terrainRadius: 2,
    roadRadius: 1,
    buildingRadius: 1,
    lod: [64, 32, 20, 12, 8],
    imageryBoost: 1,
    buildings: false,
    buildingsPerCell: 300,
    buildingMinArea: 90,
    fogDistance: 1700,
    shadows: false,
    maxPixelRatio: 1.2,
    substep: 1 / 150,
    rebuildBudget: 1,
    skidPoints: 600,
    concurrency: 6,
  },
  moyen: {
    terrainRadius: 3,
    roadRadius: 2,
    buildingRadius: 1,
    // L'anneau 0 ne compte qu'un seul chunk, celui sous les roues : on le garde
    // fin meme sur appareil modeste, c'est la que le sol doit suivre la chaussee.
    lod: [80, 44, 26, 14, 10],
    imageryBoost: 2, // anneau 0 en zoom+2 : ~0,85 m par pixel au sol
    buildings: true,
    buildingsPerCell: 650,
    buildingMinArea: 45,
    fogDistance: 2400,
    shadows: false,
    maxPixelRatio: 1.5,
    substep: 1 / 180,
    rebuildBudget: 1,
    skidPoints: 900,
    concurrency: 8,
  },
  eleve: {
    terrainRadius: 3,
    roadRadius: 2,
    buildingRadius: 1,
    lod: [96, 64, 40, 20, 14],
    imageryBoost: 2,
    buildings: true,
    buildingsPerCell: 1600,
    buildingMinArea: 12,
    fogDistance: 2500,
    shadows: true,
    maxPixelRatio: 2,
    substep: 1 / 240,
    rebuildBudget: 2,
    skidPoints: 2400,
    concurrency: 10,
  },
};

/**
 * @param preset identifiant de PRESETS, 'auto' compris
 * @returns un profil complet, pret a etre applique
 */
export function qualityProfile(device, preset = 'auto') {
  const resolved = preset === 'auto' ? autoPreset(device) : preset;
  const base = PROFILES[resolved] || PROFILES.moyen;

  return {
    ...base,
    preset,
    resolved,
    // Un ecran tres dense sur un GPU mobile est le piege classique : on rend
    // neuf fois trop de pixels pour un resultat que personne ne distingue.
    pixelRatio: Math.min(devicePixelRatio, base.maxPixelRatio),
    shadowMapSize: device.mobile ? 1024 : 2048,
    softShadows: base.shadows && !device.mobile,
    antialias: base.shadows && !device.mobile,
    // PMREM rend dans des cibles en demi-flottant, mal supportees par une partie
    // des GPU mobiles : la carte d'environnement en ressort invalide et un NaN se
    // propage dans TOUT le calcul d'eclairage, rendant la scene noire. Constate
    // sur Mali-G1-Ultra. Voir aussi la reparation automatique dans main.js.
    environmentMap: !device.mobile,
  };
}
