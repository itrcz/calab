# ADR-0144: Preserve imported CalDAV DATE intervals

Status: proposed, 2026-10-28. Independent prerequisite for calendar widget reads.

## Problem

CalDAV `VALUE=DATE` is a calendar date, with an exclusive end date. Import currently converts it to UTC using the user's profile timezone and stores only timestamps. If that timezone later changes, the original dates cannot be recovered reliably from those timestamps. In particular, an Auckland import interpreted in Los Angeles can move to the previous calendar day.

## Decision

Preserve `start_date` and `end_date` as ISO calendar dates when expanding each all-day occurrence, before conversion to UTC. Migration `00133` adds both text columns to `external_busy`, with non-null empty defaults. The existing timestamp interval remains unchanged for free/busy and existing consumers. Timed events keep empty date fields.

The importer writes dates alongside the existing batch fields. Legacy SQL writers and callers that omit the new arrays remain compatible through defaults. Previously imported rows keep empty dates until their next successful normal CalDAV sync; there is no speculative timezone-based backfill and no forced provider sync.

This change preserves source information. It does not introduce a widget endpoint, native code, a new credential, or change the existing public calendar response. Consumers can use the retained dates in a separate change. The downward migration removes only the two additive columns; roll back consumers before running it.

## Verification

Unit coverage checks exclusive DATE intervals, recurring all-day events across DST, timed events and importer batch encoding. PG17 integration imports through the existing CalDAV HTTP flow, changes the profile timezone, verifies the stored dates and timestamps, and exercises a legacy insert that omits the new columns. The widget feed has its own end-to-end projection test in its dependent change.
