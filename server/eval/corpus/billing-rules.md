# Billing Business Rules

## Invoicing

Invoices are generated on the first business day of each month. If a payment
fails, it is retried three times over seven days before the subscription is
suspended. Suspended subscriptions can be reactivated within 30 days.

## Proration

When a plan is upgraded mid-cycle, the unused portion of the current cycle is
prorated to the second and applied as a credit on the next invoice. Downgrades
take effect at the start of the next billing cycle.

## Currency

All monetary amounts are stored in minor units (for example cents) as integers,
to avoid floating point rounding errors. The base currency for all accounts is
USD.
