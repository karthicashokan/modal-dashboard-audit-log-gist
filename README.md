# Audit Log Service

Data changes persisted through this service will also persist entries into the `DashboardAuditLog` table.

## Details

### General Usage

For every model update that is persisted through this service's `create(), update(), delete()` function, a row will be created in the
`DashboardAuditLog` table *per* modifed field in the model

Consider the following

```js
// Update existing deliverySettings
const deliverySettings = DeliverySettingsProfile.findByPk(41, { include: 'deliveryFeesByDistance' });
deliverySettings.deliveryRangeMiles = 100; // old value was 50
deliverySettings.offerDeliveryTradeIn = 1; // old value was 0
deliverySettings.deliveryFeesByDistance.forEach(fee => fee.feeCents *= 0.1); // Increase all fees by 10



await auditLogService
  .init()
  .withUser(user) // user is the logged-in user - assume ID of 13
  // Update (Supports multi model changes)
  .update([deliverySettings, ...deliverySettings.deliveryFeesByDistance])
  // Create (Supports only one row creation at a time)
  .create('deliverySettings', { deliverySettingsProfile: 41, distanceMiles = 200, offerDeliveryTradeIn: 1 })
  // Delete (Supports only one row deletion at a time)
  .delete(deliverySettings)
```

This will not only create/delete/update the appropriate `DeliverySettingsProfile` row, but also create these rows in `DashboardAuditLog`

```
|Id |tableName                    |primaryKey|action                                       |oldValue                                                                                                                          |newValue                                                                     |oldLabel                                                    |newLabel                    |changesetUuidBin                  |updatedBy|updatedOn           |
|---|-----------------------------|----------|---------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------|------------------------------------------------------------|----------------------------|----------------------------------|---------|--------------------|
|1  |DeliverySettingsProfile      |41        |UPDATE                                       |{deliveryRangeMiles: 50, allowWithTradeIn: 0}                                                                                     |{deliveryRangeMiles: 100, allowWithTradeIn: 1}                               |{allowWithTradeIn: No}                                      |{allowWithTradeIn: Yes}     |0xB7C930EA7D4E11EC83670242AC130003|13       |2022-01-25 18:39:48 |
|2  |DeliveryFeeByDistance        |1         |UPDATE                                       |{feeCents: 10000}                                                                                                                 |{feeCents: 11000}                                                            |NULL                                                        |NULL                        |0xB7C930EA7D4E11EC83670242AC130003|13       |2022-01-25 18:39:48 |
|3  |DeliveryFeeByDistance        |2         |UPDATE                                       |{feeCents: 20000}                                                                                                                 |{feeCents: 22000}                                                            |NULL                                                        |NULL                        |0xB7C930EA7D4E11EC83670242AC130003|13       |2022-01-25 18:39:48 |
|4  |DeliveryFeeByDistance        |3         |CREATE                                       |NULL                                                                                                                              |{ deliverySettingsProfile: 42, distanceMiles = 200, offerDeliveryTradeIn: 1 }|NULL                                                        |{ offerDeliveryTradeIn: Yes}|0xA9C930EA7D4E11EC83643242AC130334|13       |25/1/2022 6:41:34 PM|
|5  |DeliverySettingsProfile      |41        |DELETE                                       |{id: 41, name: ‘john-eagle-acura on any website’, deliveryRangeMiles: 100, allowWithTradeIn: 1, offerDelivery: 0, offerPickup: 0 }|NULL                                                                         |{allowWithTradeIn: Yes, offerDelivery: No, offerPickup: No }|NULL                        |0xF9C930EA7D4E11EC83643242AC130233|13       |25/1/2022 6:42:11 PM|

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

- Design currently only allows one row to be created and deleted at a time
