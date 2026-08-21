// Detection de l'appareil et profil de qualite associe.
//
// On ne renifle pas la chaine user-agent : elle ment. On se fie au type de pointeur
// et a la presence d'un ecran tactile, ce qui decrit ce qui compte vraiment ici —
// est-ce qu'il y a un clavier, et est-ce qu'on rend sur un GPU de telephone.

export function detectDevice() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const touch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  const smallSide = Math.min(screen.width, screen.height);
  const mobile = coarse && touch && smallSide <= 900;
  const tablet = mobile && smallSide > 600;

  return {
    mobile,
    tablet,
    touch,
    // un ecran tres dense sur un GPU mobile est le piege classique : on rend 9 fois
    // trop de pixels pour un resultat que personne ne distingue
    pixelRatio: mobile ? Math.min(devicePixelRatio, 1.5) : Math.min(devicePixelRatio, 2),
    cores: navigator.hardwareConcurrency || 4,
  };
}

/** Reglages derives du profil. Un seul endroit a toucher pour arbitrer qualite/fluidite. */
export function qualityProfile(device) {
  if (!device.mobile) {
    return {
      terrainRadius: 3,
      roadRadius: 2,
      lod: [64, 48, 32, 16, 12],
      detailedImageryRings: 1,
      fogDistance: 2800,
      shadows: true,
      shadowMapSize: 2048,
      softShadows: true,
      antialias: true,
      substep: 1 / 240,
      rebuildBudget: 2,
      skidPoints: 2400,
      concurrency: 10,
    };
  }
  const weak = device.cores <= 4;
  return {
    terrainRadius: 2,
    roadRadius: 1,
    // L'anneau 0 ne compte qu'un seul chunk, celui sous les roues : on le garde
    // fin meme sur appareil modeste, c'est la que le sol doit suivre la chaussee.
    lod: weak ? [48, 24, 16, 12, 8] : [64, 32, 20, 12, 8],
    detailedImageryRings: 0, // imagerie fine sur le seul chunk sous les roues
    fogDistance: 1700,
    shadows: !weak,
    shadowMapSize: 1024,
    softShadows: false,
    antialias: false, // le plafonnement du pixelRatio fait deja le travail
    substep: 1 / 180,
    rebuildBudget: 1,
    skidPoints: 900,
    concurrency: 6,
  };
}
