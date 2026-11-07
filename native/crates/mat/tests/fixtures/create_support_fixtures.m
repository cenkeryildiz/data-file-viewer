% Independent MATLAB coverage gaps only; never rewrites original fixture files.
cd(fileparts(mfilename('fullpath')));
S = struct();
classes = {'int8','uint8','int16','uint16','int32','uint32','int64','uint64'};
for k = 1:numel(classes)
    c = classes{k};
    S.(c) = [intmin(c), cast(0,c), intmax(c)];
end
S.complex_single = complex(single([1, -0, NaN]), single([3, -4, Inf]));
S.complex_sparse = sparse([1,3], [2,1], complex([1,2], [3,-4]), 3,4);
S.logical_sparse = sparse(logical([0 1; 1 0]));
S.empty_sparse_rows = sparse(0,3);
S.empty_sparse_cols = sparse(3,0);
S.empty_sparse_both = sparse(0,0);
S.text_newline = sprintf('a\nb');
S.ndcells = reshape(num2cell(int16(1:8)), [2,2,2]);
S.struct_array = struct('a', {int64(1),int64(2)}, 'b', {uint8(255),uint8(0)});
S.ndstruct = reshape(struct('n', num2cell(uint16(1:8))), [2,2,2]);
for format_version = {'v6', 'v7'}
    stem = ['support_' format_version{1}];
    save([stem '.mat'], '-struct', 'S', ['-' format_version{1}]);
    R = load([stem '.mat']);
    oracle = struct();
    names = fieldnames(R);
    for k = 1:numel(names), oracle.(names{k}) = mat_dump(R.(names{k})); end
    oracle.x__whos = arrayfun(@(w) struct('name',w.name,'class',w.class,'size',w.size),whos('-file',[stem '.mat']));
    fid = fopen([stem '.oracle.json'],'w','n','UTF-8');
    fprintf(fid,'%s',jsonencode(oracle)); fclose(fid);
    members = struct();
    for name = {'struct_array','ndstruct'}
        v = R.(name{1});
        elements = cell(1,numel(v));
        for q = 1:numel(v), elements{q} = mat_dump(v(q)); end
        members.(name{1}) = elements;
    end
    fid = fopen([stem '.struct_members.oracle.json'],'w','n','UTF-8');
    fprintf(fid,'%s',jsonencode(members)); fclose(fid);
end
fprintf('Support fixture/oracle generation complete: %s\n',version('-release'));
