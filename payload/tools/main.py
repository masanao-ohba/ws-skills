"""One entry point for the ws-* skills: Google Workspace, Slack, and Backlog.

Everything retrieved lands in `references/raw-source/` under the current working
directory (override with WS_OUTPUT_DIR), so each project collects its own material.

    uv run python main.py auth                              # authorize Google (read-only)
    uv run python main.py auth --check                      # token status
    uv run python main.py gdoc <DOC_ID_OR_URL> [OUT_PATH]   # Google Doc -> Markdown (all tabs)
    uv run python main.py gsheet <SHEET> --list             # tab names
    uv run python main.py gcomments <FILE>                  # Drive comment threads
    uv run python main.py gcal --from 2026-04-01 --to 2026-04-30 [--calendar all]

    uv run python main.py gsheet-write <SHEET> --range 'Tab!A1' --values '[["a"]]'
    uv run python main.py gdoc-append <DOC> --text "..."

    uv run python main.py slack --channel release --since 2026-04-01
    uv run python main.py channels --query release
    uv run python main.py slack-signin --url https://<workspace>.slack.com/

    uv run python main.py backlog ABC123-45                 # snapshot one issue + comments
    uv run python main.py bl-explore issues --project ABC123 --keyword release
    uv run python main.py bl-digest ABC123-45

Credentials resolve from the process environment, then `.env` in the current
directory, then the shared `.env` in the config home. Run
`npx @masanao-ohba/ws-skills` to fill the shared one in.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="main.py",
        description="Fetch (and, for Google, update) Workspace, Slack and Backlog material.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_auth = sub.add_parser("auth", help="authorize Google APIs")
    p_auth.add_argument("--check", action="store_true", help="only report token status")
    p_auth.add_argument("--profile", default="default", help="Google account profile")
    p_auth.add_argument("--whoami", action="store_true", help="report which account the token belongs to")
    p_auth.add_argument(
        "--write",
        choices=["sheets", "docs"],
        help="authorize/refresh that service's separate write token",
    )
    p_auth.add_argument(
        "--open", dest="open_browser", action="store_true",
        help="open the consent URL in the default browser (off by default: signing in "
             "to a work domain in another browser can invalidate your current session)",
    )

    p_doc = sub.add_parser("gdoc", help="fetch a Google Doc as Markdown")
    p_doc.add_argument("doc", help="document ID or /document/d/... URL")
    p_doc.add_argument("out", nargs="?", help="output path (default: references/raw-source/<title>.md)")
    p_doc.add_argument("--profile", default="default", help="Google account profile")

    p_gs = sub.add_parser("gsheet", help="fetch a Google Sheet's cell values (all tabs by default)")
    p_gs.add_argument("sheet", help="spreadsheet ID or URL")
    p_gs.add_argument("--tab", help="only tabs whose title contains this string")
    p_gs.add_argument("--list", dest="list_only", action="store_true", help="list tab names only")
    p_gs.add_argument("--profile", default="default")
    p_gs.add_argument("--label", help="short name used in the output filename")

    p_gc = sub.add_parser("gcomments", help="fetch the comment threads on a Google Doc/Sheet")
    p_gc.add_argument("doc", help="file ID or docs.google.com URL")
    p_gc.add_argument("--profile", default="default", help="Google account profile")
    p_gc.add_argument("--label", help="short name used in the output filename")

    p_gw = sub.add_parser("gsheet-write", help="write cell values to a Google Sheet range (write token)")
    p_gw.add_argument("sheet", help="spreadsheet ID or URL")
    p_gw.add_argument("--range", dest="range_a1", required=True, help="A1 range, e.g. 'Tab!A1'")
    p_gw.add_argument("--values", help='JSON array of row arrays, e.g. [["a","b"]]')
    p_gw.add_argument("--csv", dest="csv_path", help="CSV file to write instead of --values")
    p_gw.add_argument("--append", action="store_true", help="append after the range's table instead of overwriting")
    p_gw.add_argument("--profile", default="default")

    p_ga = sub.add_parser("gdoc-append", help="append text to the end of a Google Doc (write token)")
    p_ga.add_argument("doc", help="document ID or URL")
    p_ga.add_argument("--text", help="text to append")
    p_ga.add_argument("--file", dest="file_path", help="file whose content to append instead of --text")
    p_ga.add_argument("--profile", default="default")

    p_cal = sub.add_parser("gcal", help="fetch Google Calendar events for a date range")
    p_cal.add_argument("--from", dest="date_from", required=True, help="YYYY-MM-DD")
    p_cal.add_argument("--to", dest="date_to", required=True, help="YYYY-MM-DD")
    p_cal.add_argument("--calendar", default="primary", help="calendar ID, or 'all' for every visible calendar")
    p_cal.add_argument("--profile", default="default", help="Google account profile")

    p_slack = sub.add_parser("slack", help="collect a Slack channel or DM")
    p_slack.add_argument(
        "--channel",
        required=True,
        help="channel name (release, #release) or ID (C0123456789). A name is looked "
        "up once per workspace and remembered",
    )
    p_slack.add_argument("--label", help="short name used in the output filename")
    p_slack.add_argument("--backend", choices=["api", "browser"], help="default: api if SLACK_TOKEN is set")
    p_slack.add_argument(
        "--since",
        help="YYYY-MM-DD; stop once older messages appear. Without it, collection runs "
        "to the beginning of the conversation — years on a long-lived channel",
    )
    p_slack.add_argument(
        "--team-id",
        help="workspace team ID, e.g. T0123456789. Defaults to SLACK_TEAM_ID. A saved "
        "session reaches any workspace the account belongs to",
    )
    p_slack.add_argument("--headless", action="store_true", help="browser backend: run without a visible window")
    p_slack.add_argument(
        "--from-app",
        action="store_true",
        help="browser backend: use the Slack desktop app's live session instead of a "
        "scripted login. Required for a workspace that signs in through Google (macOS only)",
    )

    p_ch = sub.add_parser(
        "channels",
        help="list conversations with their IDs (to look one name up, pass it to "
        "`slack --channel` directly)",
    )
    p_ch.add_argument("--query", help="case-insensitive substring filter on the name")
    p_ch.add_argument("--backend", choices=["api", "browser"])
    p_ch.add_argument("--headless", action="store_true", help="browser backend: run without a visible window")
    p_ch.add_argument("--team-id", help="workspace team ID; defaults to SLACK_TEAM_ID")
    p_ch.add_argument(
        "--from-app",
        action="store_true",
        help="browser backend: use the Slack desktop app's live session",
    )

    p_si = sub.add_parser("slack-signin", help="sign in to a Slack workspace by hand and save the session")
    p_si.add_argument("--url", required=True, help="https://<workspace>.slack.com/")

    p_bl = sub.add_parser("backlog", help="snapshot a Backlog issue (+comments) to references/raw-source/")
    p_bl.add_argument("issue", help="issue key, e.g. ABC123-45")

    p_bd = sub.add_parser("bl-digest", help="thin a Backlog snapshot into a working-notes digest")
    p_bd.add_argument("issues", nargs="*", help="issue keys")
    p_bd.add_argument("--project", help="digest every snapshot of this project key instead")

    p_be = sub.add_parser("bl-explore", help="explore a Backlog project read-only")
    be = p_be.add_subparsers(dest="mode", required=True)

    be_ov = be.add_parser("overview", help="project master data (users, types, milestones, counts)")
    be_ov.add_argument("--project", required=True, help="project key, e.g. ABC123")

    be_is = be.add_parser("issues", help="search issues (all statuses, newest updated first)")
    be_is.add_argument("--project", required=True)
    be_is.add_argument("--keyword", help="full-text keyword")
    be_is.add_argument("--since", help="updatedSince, YYYY-MM-DD")
    be_is.add_argument("--until", help="updatedUntil, YYYY-MM-DD")
    be_is.add_argument("--user", help="createdUserId")
    be_is.add_argument("--limit", type=int, default=100)
    be_is.add_argument("--save", action="store_true", help="also write the result to raw-source/")

    be_one = be.add_parser("issue", help="snapshot one issue with all comments")
    be_one.add_argument("issue", help="issue key, e.g. ABC123-45")

    be_wk = be.add_parser("wikis", help="list wiki pages")
    be_wk.add_argument("--project", required=True)
    be_wk.add_argument("--save", action="store_true")

    be_ac = be.add_parser("activities", help="recent project activity")
    be_ac.add_argument("--project", required=True)
    be_ac.add_argument("--limit", type=int, default=100)
    be_ac.add_argument("--save", action="store_true")

    return parser


def main() -> None:
    args = build_parser().parse_args()

    if args.command == "auth":
        import google_auth

        if args.check:
            google_auth.check()
        elif args.whoami:
            print(f"[auth] {args.profile} -> {google_auth.whoami(args.profile)}")
        else:
            creds = google_auth.get_credentials(args.profile, args.write, args.open_browser)
            print(f"[auth] profile: {args.profile}{' (write)' if args.write else ''}")
            print(f"[auth] valid: {creds.valid}")
            if not args.write:
                print(f"[auth] account: {google_auth.whoami(args.profile)}")

    elif args.command == "gdoc":
        import fetch_gdoc

        fetch_gdoc.fetch(args.doc, args.out, args.profile)

    elif args.command == "gsheet":
        import fetch_gsheet

        fetch_gsheet.fetch(args.sheet, args.tab, args.profile, args.label, args.list_only)

    elif args.command == "gcomments":
        import fetch_gdrive_comments

        fetch_gdrive_comments.fetch(args.doc, args.profile, args.label)

    elif args.command == "gsheet-write":
        import write_gsheet

        write_gsheet.write(
            args.sheet, args.range_a1, args.values, args.csv_path, args.profile, args.append
        )

    elif args.command == "gdoc-append":
        import write_gdoc

        write_gdoc.append(args.doc, args.text, args.file_path, args.profile)

    elif args.command == "gcal":
        import fetch_gcal

        fetch_gcal.fetch(args.date_from, args.date_to, args.calendar, args.profile)

    elif args.command == "slack":
        import fetch_slack

        channel_id = fetch_slack.resolve_channel(
            args.channel,
            team_id=args.team_id,
            headless=args.headless,
            from_app=args.from_app,
            backend=args.backend,
        )
        # Asked for by name, filed under that name rather than the ID.
        import slack_channels

        label = args.label
        if not label and not slack_channels.looks_like_id(args.channel):
            label = slack_channels.normalize(args.channel)

        fetch_slack.fetch(
            channel_id, label, args.headless, args.since, args.team_id,
            args.from_app, args.backend,
        )

    elif args.command == "channels":
        import fetch_slack

        fetch_slack.list_channels(
            args.query, args.headless, args.backend, args.team_id, args.from_app
        )

    elif args.command == "slack-signin":
        import slack_signin

        slack_signin.signin(args.url)

    elif args.command == "backlog":
        import explore_backlog
        import fetch_backlog

        try:
            fetch_backlog.fetch(args.issue)
        except explore_backlog.BacklogError as e:
            sys.exit(str(e))

    elif args.command == "bl-digest":
        import digest_backlog

        if args.project:
            digest_backlog.digest_project(args.project)
        elif args.issues:
            for key in args.issues:
                digest_backlog.digest(key)
        else:
            sys.exit("[digest] pass issue keys, or --project to digest a whole project")

    elif args.command == "bl-explore":
        import explore_backlog

        try:
            if args.mode == "overview":
                explore_backlog.overview(args.project)
            elif args.mode == "issues":
                explore_backlog.issues(
                    args.project, args.keyword, args.since, args.until, args.user,
                    args.limit, args.save,
                )
            elif args.mode == "issue":
                explore_backlog.issue(args.issue)
            elif args.mode == "wikis":
                explore_backlog.wikis(args.project, args.save)
            elif args.mode == "activities":
                explore_backlog.activities(args.project, args.limit, args.save)
        except explore_backlog.BacklogError as e:
            sys.exit(str(e))


if __name__ == "__main__":
    main()
