% Genuine MATLAB fixtures and oracles for the MAT M1/M2 tests.
% Run from this directory: matlab -batch "create_mat_fixtures"
% MRW1992data.mat is only loaded (read); every other .mat here is rewritten.

% 1. Supported projections, compressed (-v7) and uncompressed (-v6).
P.row = uint64([0 1 intmax('uint64')]);
P.column = P.row';
P.i64 = [intmin('int64'); int64(-2^53) - 1; int64(0); int64(2^53) + 1; intmax('int64')];
P.edges = [2^53; -2^53; 0; -0; NaN; Inf; -Inf; realmin; realmax; eps; 0.1];
P.single_vals = single([1.5; -0; NaN; Inf]);
P.small_ints = [1; 2; 3];                       % double MATLAB stores as uint8
P.text = char([32 304 305 351 287 32 hex2dec('D83D') hex2dec('DE00') 32]);
P.text_rows = ['ab ' ; 'çd '];
P.empty_text = '';
P.logical_values = logical([0 1; 1 0]);
P.empty_rows = zeros(0, 3);
P.scalar_struct = struct('ids', P.column, 'labels', {{'one'; ''; ['üç' char([hex2dec('D83D') hex2dec('DE00')])]}}, ...
                         'flag', logical([1; 0; 1]));
P.cell_cols = {int32(1), 'a'; int32(-2), ''};
P.int8_vals = int8([-128; 0; 127]);
P.uint32_vals = uint32([0; 4294967295]);
P.Dup = 1; P.dup = 2;                            % case-distinct names
save('projection_v7.mat', '-struct', 'P', '-v7');
% -v6 cannot store non-ASCII char, so the uncompressed copy is ASCII-only.
P6 = rmfield(P, {'text', 'text_rows', 'scalar_struct'});
save('projection_v6.mat', '-struct', 'P6', '-v6');

% 2. Refusals beside one supported variable.
R.ok = [1; 2];
R.complex_values = complex([1 2], [3 -4]);
R.sparse_values = sparse([1 1000000], [2 1000000], [5 -2], 1000000, 1000000);
R.tensor = reshape(uint16(1:24), [2 3 4]);
R.empty_columns = zeros(3, 0);
R.nested = struct('inner', struct('x', 1));
R.struct_array = struct('a', {1, 2});
R.row_field = struct('r', [1 2 3]);
R.mixed_cell = {1; 'a'};
R.string_obj = ["a"; "b"];
R.table_obj = table(int32([1; 2]), 'VariableNames', {'count'});
R.datetime_obj = datetime(2026, 1, 1);
R.handle = @sin;
save('refusals_v7.mat', '-struct', 'R', '-v7');

% 3. One thousand variables, for selective loading.
M = struct();
for k = 1:1000
    M.(sprintf('v%04d', k)) = int64(k) * int64(1000000007);
end
save('many_v7.mat', '-struct', 'M', '-v7');

% 4. Oracles: what MATLAB itself loads from each file.
files = {'MRW1992data', 'projection_v7', 'projection_v6', 'refusals_v7', 'many_v7', ...
         'native_v7', 'unsupported_table'};
for k = 1:numel(files)
    S = load([files{k} '.mat']);
    names = fieldnames(S);
    oracle = struct();
    for n = 1:numel(names)
        oracle.(names{n}) = mat_dump(S.(names{n}));
    end
    oracle.x__whos = arrayfun(@(w) struct('name', w.name, 'class', w.class, 'size', w.size), ...
                              whos('-file', [files{k} '.mat']));
    fid = fopen([files{k} '.oracle.json'], 'w', 'n', 'UTF-8');
    fprintf(fid, '%s', jsonencode(oracle));
    fclose(fid);
end
fid = fopen('matlab-version.txt', 'w');
fprintf(fid, '%s\n%s\n', version, version('-release'));
fclose(fid);
disp('MAT fixtures and oracles written.');
