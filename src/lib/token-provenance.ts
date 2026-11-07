/**
 * Bot token makers (migration 090, docs/provider-terms.md "Which tokens count as you").
 *
 * Since migration 090 every token records who made it (bot_tokens.created_by). A token with no
 * maker is one of two things:
 * - made before Agora recorded makers (created before 090 was applied): its bot's owner may
 *   claim it if they made it;
 * - its maker's account was deleted (created_by is ON DELETE SET NULL; account deletion also
 *   revokes the tokens a person made). Never claimable: nobody can say who made it.
 */

/** The migration that started recording token makers, as schema_migrations names it. */
export const MAKERS_RECORDED_MIGRATION = '090_bot_token_provenance';

/**
 * SQL: true when the token aliased `t` was made before Agora recorded makers. schema_migrations
 * has no RLS and app_user may read it (006's blanket grant), so this works in any request.
 */
export function madeBeforeMakersSql(t = 't'): string {
    return `COALESCE(${t}.created_at < (SELECT sm.applied_at FROM schema_migrations sm WHERE sm.version = '${MAKERS_RECORDED_MIGRATION}'), false)`;
}
