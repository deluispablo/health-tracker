import type { Inference, GroupStats, Interval, Label, Reason } from "./insights/types";

export const roundOneDecimal = (value: number | null): number | null => value === null ? null : Math.round(value * 10) / 10;

export function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

export function sampleSd(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const centre = mean(xs) ?? 0;
  return Math.sqrt(xs.reduce((sum, x) => sum + (x - centre) ** 2, 0) / (xs.length - 1));
}

function logGamma(z: number): number {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let sum = 0.99999999999980993;
  for (let i = 0; i < coefficients.length; i++) sum += coefficients[i] / (z + i + 1);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

// Modified Lentz continued fraction for the regularized incomplete beta function.
function betaFraction(x: number, a: number, b: number): number {
  const nonzero = (v: number) => Math.abs(v) < 1e-300 ? 1e-300 : v;
  let c = 1;
  let d = 1 / nonzero(1 - (a + b) * x / (a + 1));
  let result = d;
  for (let m = 1; m <= 200; m++) {
    const even = 2 * m;
    let coefficient = m * (b - m) * x / ((a + even - 1) * (a + even));
    d = 1 / nonzero(1 + coefficient * d);
    c = nonzero(1 + coefficient / c);
    result *= d * c;
    coefficient = -(a + m) * (a + b + m) * x / ((a + even) * (a + even + 1));
    d = 1 / nonzero(1 + coefficient * d);
    c = nonzero(1 + coefficient / c);
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return result;
}

function studentTail(df: number): (t: number) => number {
  const a = df / 2;
  const b = 0.5;
  const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  return (t: number): number => {
    const x = df / (df + t * t);
    if (x === 1) return 0.5;
    const factor = Math.exp(a * Math.log(x) + b * Math.log1p(-x) - logBeta);
    const beta = x < (a + 1) / (a + b + 2)
      ? factor * betaFraction(x, a, b) / a
      : 1 - factor * betaFraction(1 - x, b, a) / b;
    return beta / 2;
  };
}

export function tQuantile975(df: number): number {
  if (!(df > 0)) throw new RangeError("df must be positive");
  if (df === Infinity) return 1.959963984540054;
  // Avoid cancellation in logGamma and overflow in the beta fraction at large df.
  if (df > 1e7) {
    const z = 1.959963984540054;
    return z + (z ** 3 + z) / (4 * df);
  }
  const tail = studentTail(df);
  let lo = 0;
  let hi = 1;
  while (tail(hi) > 0.025) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (tail(mid) > 0.025) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function welch(group: number[], ref: number[]): {
  diff: number; df: number | null; ci95: [number, number] | null;
} | null {
  if (group.length < 2 || ref.length < 2) return null;
  const diff = (mean(group) ?? 0) - (mean(ref) ?? 0);
  const a = (sampleSd(group) ?? 0) ** 2 / group.length;
  const b = (sampleSd(ref) ?? 0) ** 2 / ref.length;
  if (a + b === 0) return { diff, df: null, ci95: null };
  const df = (a + b) ** 2 / (a ** 2 / (group.length - 1) + b ** 2 / (ref.length - 1));
  const margin = tQuantile975(df) * Math.sqrt(a + b);
  return { diff, df, ci95: [diff - margin, diff + margin] };
}

export function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length < 5) return null;
  const mx = mean(xs) ?? 0;
  const my = mean(ys) ?? 0;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] - mx;
    const y = ys[i] - my;
    xx += x * x;
    yy += y * y;
    xy += x * y;
  }
  return xx === 0 || yy === 0 ? null : xy / Math.sqrt(xx * yy);
}

export function ar1Phi(series: (number | null)[]): number {
  const centre = mean(series.filter((x) => x !== null));
  if (centre === null) return 0;
  let numerator = 0;
  let denominator = 0;
  let pairs = 0;
  for (let i = 1; i < series.length; i++) {
    const previous = series[i - 1];
    const current = series[i];
    if (previous === null || current === null) continue;
    numerator += (current - centre) * (previous - centre);
    denominator += (previous - centre) ** 2;
    pairs++;
  }
  return pairs < 3 || denominator === 0 ? 0 : Math.max(-0.99, Math.min(0.99, numerator / denominator));
}

export function prewhiten(series: (number | null)[], phi: number): (number | null)[] {
  return series.map((value, i) => {
    const previous = i === 0 ? null : series[i - 1];
    return value === null || previous === null ? null : value - phi * previous;
  });
}

export const T975: readonly number[] = [
  12.706204736174705, 4.302652729749466, 3.182446305283711, 2.776445105197796,
  2.5705818356363146, 2.4469118511449706, 2.364624251592784, 2.3060041352041667,
  2.2621571627982036, 2.2281388519862757, 2.2009851600916415, 2.178812829667229,
  2.160368656462791, 2.1447866879178044, 2.131449545559774, 2.119905299221254,
  2.1098155778333165, 2.100922040241038, 2.0930240544083096, 2.085963447265863,
  2.079613844727679, 2.0738730679040245, 2.0686576104190477, 2.063898561628024,
  2.0595385527532946, 2.0555294386428713, 2.051830516480284, 2.048407141795246,
  2.0452296421327016, 2.042272456301239, 2.039513446396403, 2.0369333434601007,
  2.034515297449337, 2.0322445093177226, 2.0301079282503407, 2.0280940009804427,
  2.0261924630291075, 2.0243941639119667, 2.0226909200367604, 2.021075390306268,
  2.019540970441378, 2.0180817028184412, 2.0166921992278173, 2.015367574443765,
  2.0141033888808453, 2.0128955989194255, 2.011740513729766, 2.010634757624234,
  2.009575237129228, 2.008559112100764, 2.007583770315831, 2.0066468050616884,
  2.00574599531787, 2.0048792881880573, 2.004044783289138, 2.0032407188478683,
  2.002465459291008, 2.0017174841452343, 2.000995378088268, 2.0002978220142573,
  1.999623584994946, 1.9989715170333802, 1.998340542520745, 1.9977296543176868,
  1.99713790839201, 1.9965644189523015, 1.9960083540252986, 1.99546893142985,
  1.9949454151072463, 1.9944371117711883, 1.9939433678456218, 1.9934635666618772,
  1.9929971258898478, 1.992543495180938, 1.992102154002239, 1.9916726096446515,
  1.9912543953883999, 1.9908470688116875, 1.990450210230136, 1.9900634212544412,
  1.9896863234569029, 1.9893185571365675, 1.988959780175171, 1.988609666975706,
  1.9882679074772258, 1.9879342062390228, 1.9876082815890617, 1.9872898648311708,
  1.9869786995062797, 1.986674540703771, 1.9863771544186193, 1.98608631695113,
  1.9858018143458045, 1.9855234418666035, 1.9852510035055047, 1.984984311522442,
  1.9847231860139707, 1.9844674545084873, 1.9842169515864025, 1.9839715185235458,
  1.9837310029556035, 1.9834952585628645, 1.9832641447734587, 1.983037526483725,
  1.982815273795027, 1.9825972617654894, 1.9823833701756919, 1.9821734833077151,
  1.9819674897364763, 1.9817652821323737, 1.9815667570748956, 1.981371814876284,
  1.9811803594146524, 1.980992297975852, 1.9808075411038955, 1.9806260024590814,
  1.9804475986834147, 1.9802722492729363, 1.9800998764569488, 1.9799304050824196,
  1.9797637625053879, 1.9795998784866176, 1.979438685093296, 1.9792801166048632,
  1.9791241094237741, 1.9789706019906284, 1.9788195347028474, 1.9786708498378385,
  1.97852449147923, 1.9783804054470306, 1.9782385392303792, 1.9780988419241043,
  1.9779612641677278, 1.9778257580871093, 1.9776922772392656, 1.977560776558922,
  1.9774312123081574, 1.9773035420276406, 1.9771777244903217, 1.9770537196571283,
  1.9769314886342295, 1.9768109936328444, 1.9766921979297973, 1.9765750658304233,
  1.9764595626329347, 1.9763456545938003, 1.9762333088953188, 1.9761224936137536,
  1.9760131776891687, 1.9759053308966128, 1.9757989238179103, 1.9756939278152825,
  1.975590315005249, 1.9754880582343035, 1.9753871310551196, 1.9752875077034608,
  1.9751891630765699, 1.975092072712048, 1.9749962127675253, 1.9749015600007458,
  1.9748080917517972, 1.9747157859238125, 1.9746246209662939, 1.9745345758584816,
  1.9744456300923945, 1.9743577636580274, 1.9742709570280463, 1.974185191143281,
  1.9741004473990236, 1.9740167076309527, 1.973933954103115, 1.9738521694944815,
  1.9737713368875083, 1.9736914397560743, 1.9736124619543975, 1.9735343877060951,
  1.973457201593761, 1.9733808885488444, 1.973305433841436, 1.9732308230715567,
  1.9731570421591544, 1.973084077335927, 1.9730119151362349, 1.972940542389353,
  1.972869946210868, 1.9728001139954872, 1.9727310334088566, 1.9726626923813217,
  1.972595079099622, 1.972528182001335, 1.9724619897672127, 1.972396491315568,
  1.9723316757957239, 1.9722675325821517, 1.972204051268414, 1.9721412216620315,
  1.9720790337785141, 1.9720174778362733, 1.9719565442517935, 1.971896223633876,
  1.9718365067798884, 1.9717773846699518, 1.9717188484634605, 1.9716608894937488,
  1.9716034992644822, 1.9715466694452366, 1.971490391867332, 1.9714346585202303,
  1.971379461547527, 1.9713247932432783, 1.9712706460486156, 1.9712170125477648,
  1.9711638854652462, 1.9711112576622902, 1.9710591221336244, 1.9710074720044872,
  1.9709563005273756, 1.9709056010794521, 1.9708553671595208, 1.9708055923849068,
  1.9707562704894603, 1.9707073953203986, 1.9706589608357747, 1.9706109611023548,
  1.9705633902926882, 1.9705162426830998, 1.9704695126515084, 1.9704231946745505,
  1.9703772833260902, 1.97033177327507, 1.9702866592828068, 1.9702419362015067,
  1.970197598972545, 1.9701536426236692, 1.9701100622681351, 1.9700668531021321,
  1.970024010403535, 1.9699815295299214, 1.9699394059169553, 1.9698976350766721,
  1.9698562125961265, 1.9698151341353802, 1.9697743954267728, 1.9697339922723485,
  1.969693920543595, 1.9696541761788833, 1.9696147551832772, 1.969575653626046,
  1.9695368676403704, 1.9694983934211443, 1.9694602272245207, 1.9694223653662677,
  1.9693848042206339, 1.9693475402191267, 1.9693105698499025, 1.969273889655677,
  1.9692374962336534, 1.9692013862339288, 1.9691655563583499, 1.9691300033601493,
  1.9690947240422183, 1.9690597152565577, 1.9690249739032581, 1.9689904969297305,
  1.9689562813294597, 1.968922324141432, 1.9688886224492803, 1.9688551733802786,
  1.9688219741045003, 1.968789021834259, 1.968756313823282, 1.968723847365574,
  1.9686916197953526, 1.9686596284854816, 1.9686278708474765, 1.968596344330602,
  1.9685650464209097, 1.9685339746407977, 1.9685031265484372, 1.968472499737001,
  1.9684420918341452, 1.968411900500965, 1.9683819234324007, 1.9683521583551364,
  1.9683226030288177, 1.9682932552437449, 1.9682641128218181, 1.9682351736148078,
  1.9682064355045914, 1.9681778964022172, 1.9681495542478382, 1.9681214070095607,
  1.9680934526838514, 1.9680656892940407, 1.968038114890486, 1.9680107275502698,
  1.9679835253761384, 1.967956506496905, 1.967929669065653, 1.9679030112610927,
  1.9678765312857052, 1.9678502273661045, 1.9678240977520578, 1.9677981407170413,
  1.9677723545568373, 1.9677467375894686, 1.9677212881555906, 1.9676960046166,
  1.9676708853559983, 1.967645928777833, 1.9676211333067863, 1.9675964973878175,
  1.9675720194858344, 1.9675476980855482, 1.967523531690555, 1.9674995188240576,
  1.967475658027526, 1.9674519478609156, 1.9674283869023665, 1.9674049737480188,
  1.9673817070110435, 1.9673585853227182, 1.967335607330547, 1.9673127716992185,
  1.9672900771098125, 1.9672675222598879, 1.967245105862229, 1.9672228266465073,
  1.967200683356857, 1.9671786747533355, 1.9671567996109154, 1.9671350567190635,
  1.9671134448822811, 1.9670919629190773, 1.9670706096623034, 1.9670493839589818,
  1.967028284669237, 1.9670073106671797, 1.9669864608404457, 1.9669657340892708,
  1.9669451293273474, 1.9669246454803941, 1.9669042814877593, 1.9668840363001432,
  1.966863908881185, 1.9668438982061218, 1.9668240032621949, 1.9668042230483027,
  1.9667845565748445, 1.9667650028636636, 1.9667455609476563, 1.966726229870877,
  1.9667070086880027, 1.9666878964647543, 1.9666688922772462, 1.966649995212002,
  1.9666312043657106, 1.9666125188455448, 1.9665939377682657, 1.9665754602606582,
  1.9665570854591552, 1.9665388125099832, 1.9665206405684117, 1.966502568799478,
  1.9664845963767568, 1.9664667224837369, 1.9664489463121293, 1.9664312670628226,
  1.9664136839453201, 1.9663961961773495, 1.9663788029859637, 1.9663615036054156,
  1.966344297279385, 1.9663271832585507, 1.9663101608024571, 1.9662932291779813,
  1.9662763876603466, 1.9662596355318502, 1.9662429720829198, 1.9662263966111886,
  1.9662099084218005, 1.966193506827048, 1.9661771911466053, 1.9661609607071808,
  1.9661448148425769, 1.9661287528933125, 1.9661127742070748, 1.966096878137821,
  1.9660810640467195, 1.9660653313011967, 1.9660496792749211, 1.9660341073487482,
  1.966018614909066, 1.9660032013488422, 1.9659878660674348, 1.9659726084695657,
  1.96595742796681, 1.96594232397634, 1.9659272959208813, 1.9659123432294225,
];

export function t975(df: number): number {
  if (Number.isNaN(df)) throw new RangeError("df must be a number");
  return df > 400 ? 1.959963984540054 : T975[Math.max(1, Math.floor(df)) - 1];
}

export function tCdf(t: number, df: number): number {
  if (!(df > 0)) throw new RangeError("df must be positive");
  if (df === Infinity || df > 1e7) return normalCdf(t);
  const tail = studentTail(df)(Math.abs(t));
  return t < 0 ? tail : 1 - tail;
}

export function normalCdf(z: number): number {
  if (z === 0) return 0.5;
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI)
    * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z < 0 ? tail : 1 - tail;
}

export function effectivePhi(residuals: (number | null)[]): number {
  let pairs = 0;
  for (let i = 1; i < residuals.length; i++) {
    if (residuals[i - 1] !== null && residuals[i] !== null) pairs++;
  }
  return pairs < 10 ? 0.2 : Math.max(0.2, Math.min(0.9, ar1Phi(residuals)));
}

export function inflation(phi: number): number {
  return (1 + phi) / (1 - phi);
}

export function effectiveWelch(a: number[], b: number[], f: number): Inference {
  const result: Inference = { diff: null, ci95: null, p: null, df: null,
    phi: (f - 1) / (f + 1), n_eff_a: a.length / f, n_eff_b: b.length / f };
  if (a.length < 3 || b.length < 3) return result;
  const diff = (mean(a) ?? 0) - (mean(b) ?? 0);
  result.diff = diff;
  const na = result.n_eff_a, nb = result.n_eff_b;
  if (na < 2 || nb < 2) return result;
  const va = (sampleSd(a) ?? 0) ** 2 / na;
  const vb = (sampleSd(b) ?? 0) ** 2 / nb;
  if (va + vb === 0) return { ...result, ci95: [diff, diff], p: diff === 0 ? 1 : 0 };
  const df = Math.max(1, Math.floor((va + vb) ** 2 / (va ** 2 / (na - 1) + vb ** 2 / (nb - 1))));
  const se = Math.sqrt(va + vb);
  const margin = t975(df) * se;
  return { ...result, df, ci95: [diff - margin, diff + margin], p: 2 * tCdf(-Math.abs(diff) / se, df) };
}

function calendarGroups(a: (number | null)[], b: (number | null)[]): { a: number[]; b: number[]; stats: GroupStats } {
  if (a.length !== b.length) throw new RangeError("Group calendars must have equal lengths");
  if (a.some((x, i) => x !== null && b[i] !== null)) throw new RangeError("Group calendars must be disjoint");
  const aa = a.filter(x => x !== null), bb = b.filter(x => x !== null);
  const ma = mean(aa), mb = mean(bb);
  const residuals = a.map((x, i) => x !== null ? x - (ma ?? 0) : b[i] !== null ? b[i] - (mb ?? 0) : null);
  const phi = effectivePhi(residuals), f = inflation(phi);
  const enough = aa.length >= 3 && bb.length >= 3;
  return { a: aa, b: bb, stats: { n_a: aa.length, n_b: bb.length, mean_a: enough ? ma : null, mean_b: enough ? mb : null,
    diff: enough ? (ma ?? 0) - (mb ?? 0) : null, ci95: null, p: null, df: null, phi, n_eff_a: aa.length / f, n_eff_b: bb.length / f } };
}

export function dependentWelch(a: (number | null)[], b: (number | null)[]): GroupStats {
  const groups = calendarGroups(a, b);
  return { ...groups.stats, ...effectiveWelch(groups.a, groups.b, inflation(groups.stats.phi)), phi: groups.stats.phi };
}

export function newcombeDiff(xa: number, na: number, xb: number, nb: number): Interval {
  const wilson = (x: number, n: number): Interval => {
    const p = x / n, z2 = 1.959963984540054 ** 2;
    const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
    const margin = Math.sqrt(z2 * (p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
    return [centre - margin, centre + margin];
  };
  const pa = xa / na, pb = xb / nb, diff = pa - pb;
  const [la, ua] = wilson(xa, na), [lb, ub] = wilson(xb, nb);
  return [diff - Math.hypot(pa - la, ub - pb), diff + Math.hypot(ua - pa, pb - lb)];
}

export function dependentRiskDiff(a: (0 | 1 | null)[], b: (0 | 1 | null)[]): GroupStats {
  const { a: aa, b: bb, stats } = calendarGroups(a, b);
  if (stats.diff === null || stats.n_eff_a < 2 || stats.n_eff_b < 2) return stats;
  const na = stats.n_eff_a, nb = stats.n_eff_b;
  const xa = aa.reduce((sum, x) => sum + x, 0) * na / aa.length;
  const xb = bb.reduce((sum, x) => sum + x, 0) * nb / bb.length;
  const pooled = Math.max(0, Math.min(1, (xa + xb) / (na + nb)));
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / na + 1 / nb));
  return { ...stats, ci95: newcombeDiff(xa, na, xb, nb), p: se === 0 ? 1 : 2 * normalCdf(-Math.abs(stats.diff) / se) };
}

export function oneSampleDependent(d: (number | null)[]): { N: number; diff: number | null; ci95: Interval | null; p: number | null; df: number | null; phi: number; n_eff: number } {
  const values = d.filter(x => x !== null), N = values.length;
  const centre = mean(values) ?? 0;
  const phi = effectivePhi(d.map(x => x === null ? null : x - centre));
  const n_eff = N / inflation(phi);
  const result = { N, diff: N < 3 ? null : centre, ci95: null, p: null, df: null, phi, n_eff };
  if (N < 3 || n_eff < 2) return result;
  const df = Math.max(1, Math.floor(n_eff - 1));
  const se = (sampleSd(values) ?? 0) / Math.sqrt(n_eff);
  const margin = t975(df) * se;
  return { ...result, df, ci95: [centre - margin, centre + margin],
    p: se === 0 ? (centre === 0 ? 1 : 0) : 2 * tCdf(-Math.abs(centre) / se, df) };
}

export function benjaminiHochberg(ps: (number | null)[]): (number | null)[] {
  const sorted = ps.flatMap((p, i) => p === null ? [] : [{ p, i }]).sort((a, b) => a.p - b.p);
  const result: (number | null)[] = ps.map(() => null);
  let q = 1;
  for (let j = sorted.length - 1; j >= 0; j--) {
    q = Math.min(q, sorted[j].p * sorted.length / (j + 1));
    result[sorted[j].i] = q;
  }
  return result;
}

export function labelOf(r: { n_a: number; n_b: number; diff: number | null; ci95: Interval | null; q: number | null; rope: number }): { label: Label; reason: Reason | null } {
  if (r.n_a < 3 || r.n_b < 3) return { label: "sin_datos", reason: null };
  if (r.n_a < 8 || r.n_b < 8) return { label: "indicio", reason: "few_days" };
  if (r.ci95 === null) return { label: "indicio", reason: "few_effective_days" };
  if (r.ci95[0] >= -r.rope && r.ci95[1] <= r.rope) return { label: "sin_diferencia", reason: null };
  const significant = (r.ci95[0] > 0 || r.ci95[1] < 0) && r.q !== null && r.q <= 0.1;
  if (significant && r.diff !== null && Math.abs(r.diff) >= r.rope) return { label: "probable", reason: null };
  return { label: "indicio", reason: significant ? "small_effect" : "uncertain" };
}
