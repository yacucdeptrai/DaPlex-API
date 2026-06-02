jest.mock('dns/promises');
jest.mock('dns', () => ({ setServers: jest.fn() }));

import * as dns from 'dns/promises';

import { ensureSrvResolvable, parseSrvHost } from './mongo-connectivity';

const mockedDns = dns as jest.Mocked<typeof dns>;
const HOST = 'daplex.inc8oif.mongodb.net';
const SRV_OK = [{ name: 'shard-00-00.example.net', port: 27017, priority: 0, weight: 0 }];

describe('parseSrvHost', () => {
  it('extracts the cluster host from a mongodb+srv URI with credentials', () => {
    expect(parseSrvHost('mongodb+srv://user:pass@daplex.inc8oif.mongodb.net/')).toBe(HOST);
  });

  it('returns null for an unparseable connection string', () => {
    expect(parseSrvHost('not-a-uri')).toBeNull();
  });
});

describe('ensureSrvResolvable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Silence the Logger noise emitted on the fallback paths.
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('switches to public resolvers when the OS resolver is loopback-only', async () => {
    mockedDns.getServers.mockReturnValue(['127.0.0.1']);
    mockedDns.resolveSrv.mockResolvedValue(SRV_OK);

    await ensureSrvResolvable(HOST);

    expect(mockedDns.setServers).toHaveBeenCalledWith(['1.1.1.1', '8.8.8.8']);
  });

  it('leaves a working non-loopback resolver untouched', async () => {
    mockedDns.getServers.mockReturnValue(['8.8.8.8', '1.1.1.1']);
    mockedDns.resolveSrv.mockResolvedValue(SRV_OK);

    await ensureSrvResolvable(HOST);

    expect(mockedDns.setServers).not.toHaveBeenCalled();
    expect(mockedDns.resolveSrv).toHaveBeenCalledTimes(1);
  });

  it('falls back to public resolvers when a non-loopback resolver cannot answer SRV', async () => {
    mockedDns.getServers.mockReturnValue(['10.0.0.1']);
    const refused = Object.assign(new Error('querySrv ECONNREFUSED'), { code: 'ECONNREFUSED' });
    mockedDns.resolveSrv.mockRejectedValueOnce(refused).mockResolvedValueOnce(SRV_OK);

    await ensureSrvResolvable(HOST);

    expect(mockedDns.setServers).toHaveBeenCalledWith(['1.1.1.1', '8.8.8.8']);
    expect(mockedDns.resolveSrv).toHaveBeenCalledTimes(2);
  });

  it('treats an empty resolver list as loopback-only and applies the fallback', async () => {
    mockedDns.getServers.mockReturnValue([]);
    mockedDns.resolveSrv.mockResolvedValue(SRV_OK);

    await ensureSrvResolvable(HOST);

    expect(mockedDns.setServers).toHaveBeenCalledWith(['1.1.1.1', '8.8.8.8']);
  });

  it('does not throw when even the public resolvers fail', async () => {
    mockedDns.getServers.mockReturnValue(['127.0.0.1']);
    mockedDns.resolveSrv.mockRejectedValue(new Error('still broken'));

    await expect(ensureSrvResolvable(HOST)).resolves.toBeUndefined();
    expect(mockedDns.setServers).toHaveBeenCalledWith(['1.1.1.1', '8.8.8.8']);
  });
});
