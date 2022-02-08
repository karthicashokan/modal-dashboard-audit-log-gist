# Audit Log Service

Data changes persisted through this service will also persist entries into the `DashboardAuditLog` table.

## Details

### General Usage

For every model update that is persisted through this service's `saveChangeSet()` function, a row will be created in the
`DashboardAuditLog` table *per* modifed field in the model

Consider the following

```js
const deliverySettings = DeliverySettingsProfile.findByPk(42, { include: 'deliveryFeesByDistance' });
deliverySettings.deliveryRangeMiles = 100; // old value was 50
deliverySettings.offerDeliveryTradeIn = 1; // old value was 0
deliverySettings.deliveryFeesByDistance.forEach(fee => fee.feeCents *= 0.1); // Increase all fees by 10%

await auditLogService
  .init()
  .withUser(user) // user is the logged-in user - assume ID of 13
  // Create (Supports only one row creation at a time)
  .create('deliverySettings', {})
  // Delete (Supports only one row deletion at a time)
  .delete(deliverySettings)
  // Update (Supports multi model changes)
  .update([deliverySettings, ...deliverySettings.deliveryFeesByDistance])
```

This will not only update the appropriate `DeliverySettingsProfile` row, but also create these rows in `DashboardAuditLog`

```
+--+-----------------------+--------------------+----------+--------+--------+--------+--------+----------------------------------+---------+-------------------+
|id|tableName              |fieldName           |primaryKey|oldValue|newValue|oldLabel|newLabel|changesetUuidBin                  |updatedBy|updatedOn          |
+--+-----------------------+--------------------+----------+--------+--------+--------+--------+----------------------------------+---------+-------------------+
|1 |DeliverySettingsProfile|deliveryRangeMiles  |42        |50      |100     |NULL    |NULL    |0xB7C930EA7D4E11EC83670242AC130003|13       |2022-01-25 18:39:48|
|2 |DeliverySettingsProfile|offerDeliveryTradeIn|42        |0       |1       |No      |Yes     |0xB7C930EA7D4E11EC83670242AC130003|13       |2022-01-25 18:39:48|
|3 |DeliveryFeeByDistance  |feeCents            |1         |10000   |11000   |NULL    |NULL    |0xB7C930EA7D4E11EC83670242AC130003|13       |2022-01-25 18:39:48|
|4 |DeliveryFeeByDistance  |feeCents            |2         |15000   |16500   |NULL    |NULL    |0xB7C930EA7D4E11EC83670242AC130003|13       |2022-01-25 18:39:48|
+--+-----------------------+--------------------+----------+--------+--------+--------+--------+----------------------------------+---------+-------------------+
```

Note that this assumes that `DeliverySettingsProfile` has implemented `labelValue()` in a manner similar to:

```js
labelValue(value, fieldName) {
  const fieldValueMap = {
    offerDeliveryTradeIn: setting => ['0', 'false'].includes(setting.toString()) ? 'No' : 'Yes',
  };
  
  return fieldValueMap?.[fieldName](value) ?? null;
}
```

### Labels

One of the challenges this design attempts to overcome is that it is not uncommon for the persisted value to differ from the
value the end-user sees. The audit log tracks changes to both the underlying persisted value as well as the label version. To
support this for any given table, this design proposes that model classes implement a `labelValue()` function that will know
how to convert persisted values to human-readable values. If no such function is provided, labels are assumed to be not needed and are set to `NULL`.

### Change Sets

The data model and related code are associated around change sets, or, a single persistence action. Think of a change set as
everything a user intends to update with a single click. All audit log entries that belong to a single change set are
identified by a UUID.

For details on storing a UUID as binary, see [this MySQL blog post](https://dev.mysql.com/blog-archive/storing-uuid-values-in-mysql-tables/).

## Limitations

- For a table to be auditable, it must have a non-composite primary key.

## Implmentation Gaps

- Design does not yet accommodate the logging of newly-added rows, only changes to existing rows
- Design is not compatible with saving a composite model (i.e., where associations are updated at the same time)
