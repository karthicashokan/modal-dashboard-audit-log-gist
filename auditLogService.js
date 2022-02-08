const { DashboardUser } = require('@drivemotors/drive-sdk/db');
const DBModels = require('@drivemotors/drive-sdk/db');
const { DriveError } = require('@drivemotors/drive-sdk/errors');
const sequelize = require('sequelize');
const { Model } = require('sequelize');
const _ = require('lodash');
const uuid = require('uuid/v4');
const logger = require('@drivemotors/logger')('auditLogService');

/**
 * The AUDIT_ACTIONS currently supported
 * Move this to constants
 * @type {{DELETE: string, CREATE: string, UPDATE: string}}
 */
const AUDIT_ACTIONS = {
    CREATE: 'CREATE',
    DELETE: 'DELETE',
    UPDATE: 'UPDATE',
}

/**
 * Returns the primary key for the model provided
 * @param {object} model
 * @returns {string}
 */
const getPrimaryKeyForModel = (model) => {
    const { primaryKeyAttributes } = model;
    const primaryKeyValues = _.map(primaryKeyAttributes, (primaryKeyAttribute) => {
        return model[primaryKeyAttribute];
    })
    // Composite primary keys will be stored as comma separated
    return primaryKeyValues.join();
};

// Temporary - to be replaced by a real model import
class DashboardAuditLog extends Model {}

class AuditLogServiceMisConfiguredError extends DriveError {}

class AuditLogServiceInvalidActionError extends DriveError {}

class AuditLogServiceUnknownTableNameError extends DriveError {}

class AuditLogServiceInvalidChangeSetError extends DriveError {}

class AuditLogService {
    #user;
    #transaction;

    /**
     * Set DashboardUser that will be associated with all updates
     *
     * @param {DashboardUser} user  The dashboard user making the changes
     * @returns {AuditLogService}
     */
    withUser(user) {
        this.#user = user;
        return this;
    }

    /**
     * Optionally supply an existing transaction
     *
     * @param transaction
     * @returns {AuditLogService}
     */
    withTransaction(transaction) {
        this.#transaction = transaction;
        return this;
    }

    /**
     * Determine the provided model is supported by this service
     *
     * @param {any} model
     * @returns {boolean}
     */
    static supportedModel(model) {
        const isSequelizeModel = model instanceof Model;
        return isSequelizeModel;
    }

    static verifyArguments(changeSet) {
        // 1. Make sure user is initialized
        if (!this.#user) {
            throw new AuditLogServiceMisConfiguredError('Providing a user is required');
        }
        // 2. Make sure model is supported
        if (!changeSet.every(AuditLogService.supportedModel)) {
            throw AuditLogServiceInvalidChangeSetError('One or more of the provided models are invalid');
        }
    }

    /**
     * Returns promise to create row in tableName + row in DashboardAuditLog table
     * @param {object} data
     * @param {string} changedBy
     * @returns {function(*): *}
     */
    static createModel(data, changedBy) {
        const { tableName } = data;
        const model = DBModels[tableName];
        if (!model) {
            throw AuditLogServiceUnknownTableNameError('Unknown table name provided');
        }
        // Delete tableName from data
        delete dataWithTableName.tableName;
        // Return promise to create row in tableName + row in DashboardAuditLog table
        return (promises) => {
            const createRow = () => {
                return model.create(data);
            };
            const createRowWithAudit = createRow.then((row) => {
                return DashboardAuditLog.create({
                    changesetUuidBin: uuid(),
                    tableName,
                    action: AUDIT_ACTIONS.CREATE,
                    primaryKey: getPrimaryKeyForModel(row),
                    oldValue: null,
                    newValue: data,
                    oldLabel: null,
                    newLabel: labelValue(data),
                    changedBy
                });
            });
            return [...promises, createRowWithAudit()];
        }
    }

    /**
     * Returns promise to delete row in table + add row in DashboardAuditLog table
     * @param {object} model
     * @param {string} changedBy
     * @returns {function(*): *}
     */
    static destroyModel(model, changedBy) {
        AuditLogService.verifyArguments([model]);
        const { tableName } = model;
        // Return promise to delete row in table + add row in DashboardAuditLog table
        return (promises) => {
            const destroyRow = () => {
                return model.destroy();
            };
            const destroyRowAndCreateAudit = destroyRow.then(() => {
                return DashboardAuditLog.create({
                    changesetUuidBin: uuid(),
                    tableName,
                    action: AUDIT_ACTIONS.DELETE,
                    primaryKey: getPrimaryKeyForModel(model),
                    oldValue: model,
                    newValue: null,
                    oldLabel: labelValue(model),
                    newLabel: null,
                    changedBy
                });
            });
            return [...promises, destroyRowAndCreateAudit()];
        }
    }

    /**
     * Returns promise to update row in table + add row in DashboardAuditLog table
     * @param {list} changeSet
     * @param {string} changedBy
     * @returns {function(*): *}
     */
    static updateChangeSet(changeSet, changedBy) {
        // Return promise to update row in table + add row in DashboardAuditLog table
        return (promises, model) => {
            const modelUpdateReducer = (uuidString, changedBy) => {
                return (promises, model) => {
                    const { tableName } = model;
                    const oldValue = {};
                    const newValue = {};
                    model.changed().map(fieldName => {
                        oldValue[fieldName] = model.previous(fieldName);
                        newValue[newValue] = model.get(fieldName);
                    });

                    const createAudit = model.changed().map(fieldName => {
                        return DashboardAuditLog.create({
                            changesetUuidBin: uuidString,
                            tableName,
                            fieldName,
                            primaryKey: getPrimaryKeyForModel(model),
                            oldValue,
                            newValue,
                            oldLabel: labelValue(oldValue),
                            newLabel: labelValue(newLabel),
                            changedBy
                        });
                    });
                    return [...promises, ...createAudit, model.save()];
                }
            };
            const updateReducer = modelUpdateReducer(uuid(), changedBy);
            const updates = changeSet
                .filter(model => model.changed() !== false)
                .reduce(updateReducer, []);
            return [...promises, updates];
        }
    }

    /**
     * Performm one of supported auditable actions (CREATE, DELETE, DESTROY)
     * @param {string} action
     * @param {list} changeSet
     * @param {boolean} manageTransaction
     * @returns {Promise<void>}
     */
    async execute(action, changeSet, manageTransaction = true) {
        AuditLogService.verifyArguments(changeSet);
        const actionIsPresentAndValid = !!action && Object.keys(AUDIT_ACTIONS).includes(action);
        if (!actionIsPresentAndValid) {
            throw AuditLogServiceInvalidActionError('Invalid action');
        }
        if ([AUDIT_ACTIONS.CREATE, AUDIT_ACTIONS.DELETE].includes(action)) {
            if (changeSet.length > 1) {
                throw AuditLogServiceInvalidChangeSetError('Audit Actions Create and Delete can only support one model within the changeset');
            }
        }
        const transaction = this.#transaction ?? sequelize.transaction();
        const executables = (() => {
            if (action === AUDIT_ACTIONS.UPDATE) {
                return AuditLogService.updateChangeSet(changeSet, this.#user.id);
            }
            if (action === AUDIT_ACTIONS.CREATE) {
                return AuditLogService.createModel(changeSet[0], this.#user.id);
            }
            if (action === AUDIT_ACTIONS.DELETE) {
                return AuditLogService.destroyModel(changeSet[0], this.#user.id);
            }
        })();

        const manageTransactionInternally = this.#transaction ? manageTransaction : true;
        try {
            await Promise.all(executables);
            if (manageTransactionInternally) {
                await transaction.commit();
            }
        }
        catch (error) {
            logger.error('Failed to execute action', error, { action, manageTransaction });
            if (manageTransactionInternally) {
                await transaction.rollback();
            }
            throw error;
        }
    }

}

module.exports = {
    init: () => new AuditLogService(),
    create: (tableName, data, manageTransaction = true) => AuditLogService.execute(AUDIT_ACTIONS.CREATE, [{...data, tableName}], manageTransaction),
    delete: (model, manageTransaction = true) => AuditLogService.execute(AUDIT_ACTIONS.CREATE, [model], manageTransaction),
    update: (changeSet, manageTransaction = true) => AuditLogService.execute(AUDIT_ACTIONS.UPDATE, changeSet, manageTransaction),
};
