/** Poker Admin (iPoker US) deep links — same host for all profile / search / tournament views. */
export const PA_ADMIN_BASE = 'https://pokeradmin.ipoker-us.com/pta/admin';

export function playerProfileUrl(playerCode) {
  if (playerCode == null || String(playerCode).trim() === '') return null;
  const code = String(playerCode).trim();
  return `${PA_ADMIN_BASE}/player-info/index/code/${encodeURIComponent(code)}`;
}

export function sessionCodeSearchUrl(sessionCode) {
  if (sessionCode == null || String(sessionCode).trim() === '') return null;
  const s = String(sessionCode).trim();
  return `${PA_ADMIN_BASE}/search-common_games/search-by-session-code/sessionCode/${encodeURIComponent(s)}`;
}

export function tournamentEditUrl(tournamentId) {
  if (tournamentId == null || String(tournamentId).trim() === '') return null;
  const id = String(tournamentId).trim();
  return `${PA_ADMIN_BASE}/tournaments/edit/code/${encodeURIComponent(id)}`;
}
