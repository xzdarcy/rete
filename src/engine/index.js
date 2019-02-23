import { Component } from './component';
import { Context } from '../core/context';
import { EngineEvents } from './events';
import { Recursion } from './recursion';
import { State } from './state';
import { Validator } from '../core/validator';

export { Component, Recursion };

export class Engine extends Context {

    constructor(id: string) {
        super(id, new EngineEvents());

        this.args = [];
        this.data = null;
        this.state = State.AVAILABLE;
        this.onAbort = () => { };
    }

    clone() {
        const engine = new Engine(this.id);

        this.components.forEach(c => engine.register(c));

        return engine;
    }

    async throwError (message, data = null) {
        await this.abort();
        this.trigger('error', { message, data });
        this.processDone();

        return 'error';
    }

    processStart() {
        if (this.state === State.AVAILABLE) {  
            this.state = State.PROCESSED;
            return true;
        }

        if (this.state === State.ABORT) {
            return false;
        }

        console.warn(`The process is busy and has not been restarted.
                Use abort() to force it to complete`);
        return false;
    }

    processDone() {
        const success = this.state !== State.ABORT;

        this.state = State.AVAILABLE;
        
        if (!success) {
            this.onAbort();
            this.onAbort = () => { }
        }    

        return success;
    }

    async abort() {
        return new Promise(ret => {
            if (this.state === State.PROCESSED) {
                this.state = State.ABORT;
                this.onAbort = ret;
            }
            else if (this.state === State.ABORT) {
                this.onAbort();
                this.onAbort = ret;
            }
            else
                ret();
        });
    }

    async lock(node) {
        return new Promise(res => {
            node.unlockPool = node.unlockPool || [];
            if (node.busy && !node.outputData)
                node.unlockPool.push(res);
            else 
                res();
            
            node.busy = true;
        });    
    }

    unlock(node) {
        node.unlockPool.forEach(a => a());
        node.unlockPool = [];
        node.busy = false;
    }

    async extractInputData(node) {
        const obj = {};

        for (let key of Object.keys(node.inputs)) {
            const input = node.inputs[key];
            const conns = input.connections;
            const connData = await Promise.all(conns.map(async (c) => {
                const prevNode = this.data.nodes[c.node];

                const outputs = await this.processNode(prevNode);

                if (!outputs) 
                    this.abort();
                else
                    return outputs[c.output];
            }));

            obj[key] = connData;
        }

        return obj;
    }

    async processWorker(node) {
        const inputData = await this.extractInputData(node);
        const component = this.components.get(node.name);
        const outputData = {};

        try {
            await component.worker(node, inputData, outputData, ...this.args);
        } catch (e) {
            this.abort();
            this.trigger('warn', e);
        }

        return outputData;
    }

    async processNode(node) {
        if (this.state === State.ABORT || !node)
            return null;
        
        await this.lock(node);

        if (!node.outputData) {
            node.outputData = this.processWorker(node)
        }

        this.unlock(node);
        return node.outputData;
    }

    async forwardProcess(node) {
        if (this.state === State.ABORT)
            return null;

        return await Promise.all(Object.keys(node.outputs).map(async (key) => {
            const output = node.outputs[key];

            return await Promise.all(output.connections.map(async (c) => {
                const nextNode = this.data.nodes[c.node];

                await this.processNode(nextNode);
                await this.forwardProcess(nextNode);
            }));
        }));
    }

    copy(data) {
        data = Object.assign({}, data);
        data.nodes = Object.assign({}, data.nodes);
        
        Object.keys(data.nodes).forEach(key => {
            data.nodes[key] = Object.assign({}, data.nodes[key])
        });
        return data;
    }

    async validate(data) {
        const checking = Validator.validate(this.id, data);
        const recursion = new Recursion(data.nodes);

        if (!checking.success)
            return await this.throwError(checking.msg);  
        
        const recurrentNode = recursion.detect();

        if (recurrentNode)
            return await this.throwError('Recursion detected', recurrentNode);      
         
        return true;
    }

    async processStartNode(id) {
        if (id) {
            let startNode = this.data.nodes[id];

            if (!startNode)
                return await this.throwError('Node with such id not found');   
            
            await this.processNode(startNode);
            await this.forwardProcess(startNode);
        }
    }

    async processUnreachable() {
        for (let i in this.data.nodes) // process nodes that have not been reached
            if (typeof this.data.nodes[i].outputData === 'undefined') {
                const node = this.data.nodes[i];

                await this.processNode(node);
                await this.forwardProcess(node);
            }
    }

    async process(data: Object, startId: ?number = null, ...args) {
        if (!this.processStart()) return;
        if (!this.validate(data)) return;    
        
        this.data = this.copy(data);
        this.args = args;

        await this.processStartNode(startId);
        await this.processUnreachable();
        
        return this.processDone()?'success':'aborted';
    }
}